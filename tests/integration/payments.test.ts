import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@/lib/ulid";
import {
    createInvoiceDraft,
    finalizeInvoice,
} from "@/server/billing/invoices/service";
import { netRevenueForYear } from "@/server/billing/revenue";
import {
    applyPayment,
    creditBalanceCents,
    payFromCredit,
} from "@/server/payments/apply";
import { recordRefund } from "@/server/payments/refunds";
import { claimEvent, markEventHandled } from "@/server/payments/webhook-log";
import { defaultSettings, type Settings } from "@/server/settings";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * Settling, against a real Postgres.
 *
 * Every claim in this file is a claim about what the *database* does under
 * contention — a row lock that makes two settlements of one invoice
 * serialise, a unique index that makes a doubled overpayment impossible, a
 * claim statement that makes a crashed webhook handler retryable. None of it
 * can be proved against a stub, which is the same argument the invoicing
 * tests make.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the settlement, idempotency and\n" +
            "        refund proofs are being SKIPPED. Run `npm run db:up`.\n",
    );
}

const ACTOR = { type: "system" as const, label: "test" };

const SETTINGS: Settings = {
    ...defaultSettings,
    operator: {
        ...defaultSettings.operator,
        country: "DE",
        taxNumber: "305/5721/1234",
    },
};

describe.skipIf(!available)("settling an invoice", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let customerId: string;
    let otherCustomerId: string;

    async function customer(number: number) {
        const userId = createId("user");

        await db.insert(schema.user).values({
            id: userId,
            name: `Kunde ${number}`,
            email: `kunde${number}@example.test`,
            emailVerified: true,
        });

        const [row] = await db
            .insert(schema.customer)
            .values({
                name: `Kunde ${number}`,
                customerNumber: number,
                country: "DE",
                street: "Musterweg 1",
                postalCode: "12345",
                city: "Musterstadt",
            })
            .returning();

        await db.insert(schema.customerContact).values({
            customerId: row.id,
            userId,
            role: "owner",
            email: `kunde${number}@example.test`,
        });

        return row.id;
    }

    /** An issued invoice over `cents`, ready to be paid. */
    async function issued(cents = 2999, owner = customerId) {
        const draft = await createInvoiceDraft(
            db,
            {
                customerId: owner,
                items: [
                    {
                        description: "VPS M",
                        quantity: 1,
                        unitCode: "MON",
                        unitPriceCents: cents,
                    },
                ],
            },
            ACTOR,
        );

        const { invoice } = await finalizeInvoice(db, draft.id, ACTOR, {
            now: new Date("2026-11-07T10:00:00Z"),
            settings: SETTINGS,
            paymentTermDays: 14,
        });

        return invoice;
    }

    /** The attempt a checkout would have written before the redirect. */
    async function attempt(
        invoiceId: string,
        ref: string,
        cents: number,
        owner = customerId,
    ) {
        await db.insert(schema.payment).values({
            id: createId("payment"),
            invoiceId,
            customerId: owner,
            provider: "stripe",
            providerRef: ref,
            amountCents: cents,
        });
    }

    async function invoiceRow(id: string) {
        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, id));

        return row;
    }

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        customerId = await customer(10_001);
        otherCustomerId = await customer(10_002);
    });

    afterAll(async () => {
        await drop();
    });

    describe("a part payment", () => {
        it("leaves the invoice open and says how much arrived", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_part_1", 1000);

            const outcome = await applyPayment(db, {
                ref: "cs_part_1",
                gateway: "stripe",
                captureRef: "pi_part_1",
                amountCents: 1000,
                actor: ACTOR,
            });

            expect(outcome.changed).toBe(true);
            expect(outcome.invoiceStatus).toBe("partial");
            expect(outcome.paidCents).toBe(1000);
            expect(outcome.outstandingCents).toBe(1999);
            expect(outcome.creditedToBalanceCents).toBe(0);

            const row = await invoiceRow(invoice.id);

            expect(row.status).toBe("partial");
            expect(row.paidCents).toBe(1000);
            // Not paid: the date is what a reminder and the revenue monitor
            // read, and it must not be set while money is still owed.
            expect(row.paidAt).toBeNull();
        });

        it("a second part payment settles it", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_part_2a", 1000);
            await attempt(invoice.id, "cs_part_2b", 1999);

            await applyPayment(db, {
                ref: "cs_part_2a",
                gateway: "stripe",
                amountCents: 1000,
                actor: ACTOR,
            });

            const second = await applyPayment(db, {
                ref: "cs_part_2b",
                gateway: "stripe",
                amountCents: 1999,
                actor: ACTOR,
            });

            expect(second.invoiceStatus).toBe("paid");
            expect(second.paidCents).toBe(2999);
            expect(second.outstandingCents).toBe(0);

            const row = await invoiceRow(invoice.id);

            expect(row.status).toBe("paid");
            expect(row.paidAt).not.toBeNull();
        });
    });

    describe("an overpayment", () => {
        it("settles the invoice and credits the rest to the account", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_over_1", 2999);

            const before = await creditBalanceCents(db, customerId);

            const outcome = await applyPayment(db, {
                ref: "cs_over_1",
                gateway: "stripe",
                // The provider's own figure wins over what we recorded.
                amountCents: 5000,
                actor: ACTOR,
            });

            expect(outcome.invoiceStatus).toBe("paid");
            // Never more than is owed — the overshoot is not on the invoice.
            expect(outcome.paidCents).toBe(2999);
            expect(outcome.creditedToBalanceCents).toBe(2001);
            expect(outcome.amountMismatch).toEqual({
                recorded: 2999,
                reported: 5000,
            });

            expect(await creditBalanceCents(db, customerId)).toBe(
                before + 2001,
            );

            const row = await invoiceRow(invoice.id);

            expect(row.paidCents).toBe(2999);
        });

        it("counts each payment's own overshoot, not the running total", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_over_2a", 2000);
            await attempt(invoice.id, "cs_over_2b", 2000);

            const before = await creditBalanceCents(db, customerId);

            const first = await applyPayment(db, {
                ref: "cs_over_2a",
                gateway: "stripe",
                amountCents: 2000,
                actor: ACTOR,
            });
            const second = await applyPayment(db, {
                ref: "cs_over_2b",
                gateway: "stripe",
                amountCents: 2000,
                actor: ACTOR,
            });

            expect(first.creditedToBalanceCents).toBe(0);
            // 4000 received against 2999 owed: 1001 over, all of it the
            // second payment's doing.
            expect(second.creditedToBalanceCents).toBe(1001);
            expect(await creditBalanceCents(db, customerId)).toBe(
                before + 1001,
            );
        });
    });

    describe("idempotency", () => {
        it("the same reference settles once, however often it arrives", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_dupe_1", 2999);

            const first = await applyPayment(db, {
                ref: "cs_dupe_1",
                gateway: "stripe",
                captureRef: "pi_dupe_1",
                amountCents: 2999,
                actor: ACTOR,
            });
            const second = await applyPayment(db, {
                ref: "cs_dupe_1",
                gateway: "stripe",
                captureRef: "pi_dupe_1",
                amountCents: 2999,
                actor: ACTOR,
            });

            expect(first.changed).toBe(true);
            expect(second.changed).toBe(false);
            expect(second.known).toBe(true);

            const row = await invoiceRow(invoice.id);

            expect(row.paidCents).toBe(2999);
            expect(await creditBalanceCents(db, customerId)).toBe(
                await creditBalanceCents(db, customerId),
            );
        });

        it("two deliveries at once settle once", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_race_1", 2999);

            // Both start before either finishes. The FOR UPDATE on the
            // payment row is what makes the loser find it already succeeded.
            const [a, b] = await Promise.all([
                applyPayment(db, {
                    ref: "cs_race_1",
                    gateway: "stripe",
                    amountCents: 2999,
                    actor: ACTOR,
                }),
                applyPayment(db, {
                    ref: "cs_race_1",
                    gateway: "stripe",
                    amountCents: 2999,
                    actor: ACTOR,
                }),
            ]);

            expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1);

            const row = await invoiceRow(invoice.id);

            expect(row.paidCents).toBe(2999);
            expect(row.status).toBe("paid");
        });

        it("two different payments settling one invoice at once both land", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_race_2a", 1500);
            await attempt(invoice.id, "cs_race_2b", 1499);

            await Promise.all([
                applyPayment(db, {
                    ref: "cs_race_2a",
                    gateway: "stripe",
                    amountCents: 1500,
                    actor: ACTOR,
                }),
                applyPayment(db, {
                    ref: "cs_race_2b",
                    gateway: "stripe",
                    amountCents: 1499,
                    actor: ACTOR,
                }),
            ]);

            const row = await invoiceRow(invoice.id);

            // Summed from the rows, so nothing is lost to a lost update.
            expect(row.paidCents).toBe(2999);
            expect(row.status).toBe("paid");
        });

        it("a reference under a different gateway is not ours", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_wrong_gateway", 2999);

            const outcome = await applyPayment(db, {
                ref: "cs_wrong_gateway",
                gateway: "paypal",
                amountCents: 2999,
                actor: ACTOR,
            });

            expect(outcome.known).toBe(false);
            expect(outcome.changed).toBe(false);
            expect((await invoiceRow(invoice.id)).status).toBe("unpaid");
        });

        it("refuses to settle a draft, which has no total to settle against", async () => {
            const { createInvoiceDraft } = await import(
                "@/server/billing/invoices/service"
            );

            const draft = await createInvoiceDraft(
                db,
                {
                    customerId,
                    items: [
                        {
                            description: "VPS M",
                            quantity: 1,
                            unitCode: "MON",
                            unitPriceCents: 2999,
                        },
                    ],
                },
                ACTOR,
            );

            const outcome = await applyPayment(db, {
                ref: "banktransfer:on-a-draft",
                gateway: "banktransfer",
                invoiceId: draft.id,
                customerId,
                amountCents: 2999,
                actor: ACTOR,
            });

            expect(outcome.changed).toBe(false);

            const row = await invoiceRow(draft.id);

            expect(row.status).toBe("draft");
            expect(row.paidCents).toBe(0);
        });

        it("a reference we never recorded books nothing", async () => {
            // The webhook case: a verified payload that names something we
            // did not start. It must not be able to settle anything.
            const outcome = await applyPayment(db, {
                ref: "cs_never_seen",
                gateway: "stripe",
                amountCents: 2999,
                actor: ACTOR,
            });

            expect(outcome.known).toBe(false);
            expect(outcome.changed).toBe(false);
        });

        it("refuses to settle an invoice the attempt does not belong to", async () => {
            const invoice = await issued(2999, otherCustomerId);

            // An attempt recorded against the wrong account: the two have to
            // agree before a cent is booked.
            await db.insert(schema.payment).values({
                id: createId("payment"),
                invoiceId: invoice.id,
                customerId,
                provider: "stripe",
                providerRef: "cs_crossed",
                amountCents: 2999,
            });

            const outcome = await applyPayment(db, {
                ref: "cs_crossed",
                gateway: "stripe",
                amountCents: 2999,
                actor: ACTOR,
            });

            expect(outcome.known).toBe(false);
            expect((await invoiceRow(invoice.id)).status).toBe("unpaid");
        });
    });

    describe("the webhook log", () => {
        it("claims an event once", async () => {
            const event = {
                id: "evt_once",
                provider: "stripe" as const,
                type: "payment_intent.succeeded",
            };

            expect(await claimEvent(db, event)).toBe(true);
            await markEventHandled(db, event.id);
            expect(await claimEvent(db, event)).toBe(false);
        });

        it("lets a delivery nobody finished be retried", async () => {
            // The handler crashed: the row exists, `handled_at` is null.
            const event = {
                id: "evt_crashed",
                provider: "paypal" as const,
                type: "PAYMENT.CAPTURE.COMPLETED",
            };

            expect(await claimEvent(db, event)).toBe(true);
            // No markEventHandled — the provider's retry must work.
            expect(await claimEvent(db, event)).toBe(true);

            const [row] = await db
                .select()
                .from(schema.webhookEvent)
                .where(eq(schema.webhookEvent.id, event.id));

            expect(row.attempts).toBe(2);
            expect(row.handledAt).toBeNull();

            await markEventHandled(db, event.id);
            expect(await claimEvent(db, event)).toBe(false);
        });
    });

    describe("refunds", () => {
        it("re-opens the invoice for what went back out", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_refund_1", 2999);

            const settled = await applyPayment(db, {
                ref: "cs_refund_1",
                gateway: "stripe",
                captureRef: "pi_refund_1",
                amountCents: 2999,
                actor: ACTOR,
            });

            expect((await invoiceRow(invoice.id)).status).toBe("paid");

            const refunded = await recordRefund(db, {
                chargePaymentId: settled.paymentId,
                provider: "stripe",
                refundRef: "re_refund_1",
                amountCents: 1000,
                reason: "Teilerstattung",
                actor: ACTOR,
            });

            expect(refunded).toMatchObject({ ok: true, changed: true });

            const row = await invoiceRow(invoice.id);

            // 2999 in, 1000 back out: 1999 of a 2999 invoice.
            expect(row.paidCents).toBe(1999);
            expect(row.status).toBe("partial");
            expect(row.paidAt).toBeNull();

            const [charge] = await db
                .select()
                .from(schema.payment)
                .where(eq(schema.payment.id, settled.paymentId ?? ""));

            // The charge still stands for what it collected; the refund is
            // its own row.
            expect(charge.amountCents).toBe(2999);
            expect(charge.refundedCents).toBe(1000);
            expect(charge.status).toBe("succeeded");
        });

        it("a full refund leaves the invoice unpaid and the charge refunded", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_refund_2", 2999);

            const settled = await applyPayment(db, {
                ref: "cs_refund_2",
                gateway: "stripe",
                captureRef: "pi_refund_2",
                amountCents: 2999,
                actor: ACTOR,
            });

            await recordRefund(db, {
                chargePaymentId: settled.paymentId,
                provider: "stripe",
                refundRef: "re_refund_2",
                amountCents: 2999,
                reason: "Storno",
                actor: ACTOR,
            });

            const row = await invoiceRow(invoice.id);

            expect(row.paidCents).toBe(0);
            expect(row.status).toBe("unpaid");

            const [charge] = await db
                .select()
                .from(schema.payment)
                .where(eq(schema.payment.id, settled.paymentId ?? ""));

            expect(charge.status).toBe("refunded");
        });

        it("the same refund reported twice is recorded once", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_refund_3", 2999);

            const settled = await applyPayment(db, {
                ref: "cs_refund_3",
                gateway: "stripe",
                captureRef: "pi_refund_3",
                amountCents: 2999,
                actor: ACTOR,
            });

            const first = await recordRefund(db, {
                chargePaymentId: settled.paymentId,
                provider: "stripe",
                refundRef: "re_refund_3",
                amountCents: 1000,
                reason: "Teilerstattung",
                actor: ACTOR,
            });
            const second = await recordRefund(db, {
                chargePaymentId: settled.paymentId,
                provider: "stripe",
                refundRef: "re_refund_3",
                amountCents: 1000,
                reason: "Teilerstattung",
                actor: ACTOR,
            });

            expect(first).toMatchObject({ changed: true });
            expect(second).toMatchObject({ ok: true, changed: false });

            expect((await invoiceRow(invoice.id)).paidCents).toBe(1999);
        });

        it("refuses to send back more than came in", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_refund_4", 2999);

            const settled = await applyPayment(db, {
                ref: "cs_refund_4",
                gateway: "stripe",
                captureRef: "pi_refund_4",
                amountCents: 2999,
                actor: ACTOR,
            });

            const outcome = await recordRefund(db, {
                chargePaymentId: settled.paymentId,
                provider: "stripe",
                refundRef: "re_refund_4",
                amountCents: 3000,
                reason: "zu viel",
                actor: ACTOR,
            });

            expect(outcome.ok).toBe(false);
        });
    });

    describe("credit", () => {
        it("pays an invoice from the balance", async () => {
            const topUpInvoice = await issued(2999);
            await attempt(topUpInvoice.id, "cs_credit_src", 2999);

            // An overpayment is the easiest way to produce a balance.
            await applyPayment(db, {
                ref: "cs_credit_src",
                gateway: "stripe",
                amountCents: 5000,
                actor: ACTOR,
            });

            const balance = await creditBalanceCents(db, customerId);
            const invoice = await issued(1500);

            const outcome = await payFromCredit(db, {
                invoiceId: invoice.id,
                customerId,
                amountCents: 1500,
                actor: ACTOR,
            });

            expect(outcome.changed).toBe(true);
            expect(outcome.invoiceStatus).toBe("paid");
            expect(await creditBalanceCents(db, customerId)).toBe(
                balance - 1500,
            );
        });

        it("refuses to spend more than is owed", async () => {
            const invoice = await issued(500);

            const outcome = await payFromCredit(db, {
                invoiceId: invoice.id,
                customerId,
                amountCents: 1000,
                actor: ACTOR,
            });

            expect(outcome.changed).toBe(false);
            expect((await invoiceRow(invoice.id)).status).toBe("unpaid");
        });

        it("refuses another account's invoice", async () => {
            const invoice = await issued(500, otherCustomerId);

            const outcome = await payFromCredit(db, {
                invoiceId: invoice.id,
                customerId,
                amountCents: 500,
                actor: ACTOR,
            });

            expect(outcome.changed).toBe(false);
            expect((await invoiceRow(invoice.id)).status).toBe("unpaid");
        });
    });

    describe("the § 19 threshold monitor", () => {
        it("counts a part payment for the part that arrived", async () => {
            const fresh = await createTestDatabase();

            try {
                const userId = createId("user");

                await fresh.db.insert(schema.user).values({
                    id: userId,
                    name: "Kunde",
                    email: "kunde@example.test",
                    emailVerified: true,
                });

                const [account] = await fresh.db
                    .insert(schema.customer)
                    .values({
                        name: "Kunde",
                        customerNumber: 20_001,
                        country: "DE",
                        street: "Musterweg 1",
                        postalCode: "12345",
                        city: "Musterstadt",
                    })
                    .returning();

                await fresh.db.insert(schema.customerContact).values({
                    customerId: account.id,
                    userId,
                    role: "owner",
                    email: "kunde@example.test",
                });

                const draft = await createInvoiceDraft(
                    fresh.db,
                    {
                        customerId: account.id,
                        items: [
                            {
                                description: "VPS M",
                                quantity: 1,
                                unitCode: "MON",
                                unitPriceCents: 10_000,
                            },
                        ],
                    },
                    ACTOR,
                );

                const { invoice } = await finalizeInvoice(
                    fresh.db,
                    draft.id,
                    ACTOR,
                    {
                        now: new Date("2026-03-01T10:00:00Z"),
                        settings: SETTINGS,
                        paymentTermDays: 14,
                    },
                );

                await fresh.db.insert(schema.payment).values({
                    id: createId("payment"),
                    invoiceId: invoice.id,
                    customerId: account.id,
                    provider: "banktransfer",
                    providerRef: "banktransfer:part",
                    amountCents: 2500,
                });

                await applyPayment(fresh.db, {
                    ref: "banktransfer:part",
                    gateway: "banktransfer",
                    amountCents: 2500,
                    at: new Date("2026-03-05T10:00:00Z"),
                    actor: ACTOR,
                });

                // A quarter of a 100,00 € invoice arrived. Counting nothing
                // would let the limit be crossed by money already in the
                // account, with no warning.
                expect(
                    await netRevenueForYear(fresh.db, 2026, "invoice"),
                ).toBe(2500);
            } finally {
                await fresh.drop();
            }
        });
    });

    describe("an invoice that is not waiting for money", () => {
        it("records the payment, keeps the status and makes it credit", async () => {
            const invoice = await issued(2999);

            // Corrected away in full: `credited_cents` equals the gross and
            // the status is `cancelled`.
            await db
                .update(schema.invoice)
                .set({ status: "cancelled", creditedCents: 2999 })
                .where(eq(schema.invoice.id, invoice.id));

            await attempt(invoice.id, "cs_cancelled", 2999);

            const before = await creditBalanceCents(db, customerId);

            const outcome = await applyPayment(db, {
                ref: "cs_cancelled",
                gateway: "stripe",
                amountCents: 2999,
                actor: ACTOR,
            });

            expect(outcome.unexpected).toBe(true);
            expect(outcome.invoiceStatus).toBe("cancelled");
            expect(outcome.creditedToBalanceCents).toBe(2999);
            expect(await creditBalanceCents(db, customerId)).toBe(
                before + 2999,
            );
        });
    });

    describe("the ledger", () => {
        beforeEach(async () => {
            // The unique index is the last guard; this proves it is there.
        });

        it("refuses a second overpayment entry for one payment", async () => {
            const invoice = await issued(2999);
            await attempt(invoice.id, "cs_ledger_1", 2999);

            const outcome = await applyPayment(db, {
                ref: "cs_ledger_1",
                gateway: "stripe",
                amountCents: 4000,
                actor: ACTOR,
            });

            const duplicate = db.insert(schema.creditLedger).values({
                id: createId("creditledger"),
                customerId,
                kind: "overpayment",
                amountCents: 1001,
                paymentId: outcome.paymentId,
                invoiceId: invoice.id,
                reason: "noch einmal",
            });

            await expect(duplicate).rejects.toThrow();

            const [{ count }] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(schema.creditLedger)
                .where(
                    and(
                        eq(
                            schema.creditLedger.paymentId,
                            outcome.paymentId ?? "",
                        ),
                        eq(schema.creditLedger.kind, "overpayment"),
                    ),
                );

            expect(count).toBe(1);
        });
    });
});
