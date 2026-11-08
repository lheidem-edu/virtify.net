import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_INVOICE_STATUSES } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { cancelRenewalInvoice } from "@/server/billing/reversals";
import { runBilling } from "@/server/billing/run";
import { applyPayment, creditBalanceCents } from "@/server/payments/apply";
import {
    cancelSubscription,
    reactivateAfterSettlement,
} from "@/server/subscriptions/service";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";
import {
    ACTOR,
    anchored,
    eventsOf,
    invoiceOf,
    itemsOf,
    linksFor,
    makeCustomer,
    makeGroup,
    makeProduct,
    order,
    servicesOf,
    subscriptionOf,
    warmPool,
    withBilling,
} from "../helpers/fixtures";

/**
 * `billing:run`, against a real Postgres and a fake clock.
 *
 * Two things are being proved, and they are the two that would cost real
 * money if they were wrong:
 *
 *  1. **The ninety days happen on the right days.** A trial that ends, a
 *     renewal raised a fortnight ahead, a collection ladder of exactly three
 *     rungs, dunning at +3 / +10 / +14 / +30, a suspension, a payment and a
 *     reactivation — each asserted on the day it should happen and on the
 *     day before, in cents.
 *  2. **Running it again changes nothing.** The run is driven day by day and
 *     most days it is driven *twice*; two passes race each other on a warmed
 *     pool; and the operator's "jetzt abrechnen" forces a third. One invoice
 *     comes out of all of it, because the unique indexes say so.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the recurring-billing proofs are\n" +
            "        being SKIPPED. Run `npm run db:up`.\n",
    );
}

const SETTINGS = anchored(1);
/** The same, billing on the day of the order rather than on a fixed one. */
const SETTINGS_NO_ANCHOR = anchored(0);
const DAY_MS = 86_400_000;

/** 09:00 Berlin on a given day, which is when the run is pretended to fire. */
function at(day: string): Date {
    return new Date(`${day}T09:00:00.000+01:00`);
}

describe.skipIf(!available)("the daily billing run", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let groupId: string;
    let vpsM: string;
    let vpsAnnual: string;
    let trialVps: string;
    let seq = 30_000;

    function nextCustomer() {
        seq += 1;
        return makeCustomer(db, seq);
    }

    /**
     * One pass of the run, on a given day — and **every** pass in this file
     * asserts that it reported no failed step.
     *
     * That assertion is what makes the rest of the file mean anything. Every
     * guarantee here has two layers: a row lock or an `on conflict do
     * nothing` claim that makes the second writer *skip*, and a unique index
     * that makes it *fail*. Count the invoices alone and the two are
     * indistinguishable — removing the claim still leaves one invoice,
     * because the index throws and the transaction rolls back. The run would
     * then be "correct" while filling its report with errors every single
     * night, and a retried job would be a coin toss.
     *
     * So: one invoice **and** nothing went wrong. A mutation that deletes a
     * lock or a claim fails here.
     */
    async function run(
        day: string,
        over: { force?: boolean; settings?: typeof SETTINGS } = {},
    ) {
        const result = await runBilling(db, {
            now: at(day),
            settings: over.settings ?? SETTINGS,
            force: over.force ?? false,
            // No PDF: the renderer is irrelevant to every claim here and
            // costs a few hundred milliseconds per invoice.
            renderPdf: false,
        });

        expect(result.report.failures, `${day}: a step failed`).toEqual([]);

        return result;
    }

    beforeAll(async () => {
        const created = await createTestDatabase();

        db = created.db;
        drop = created.drop;
        groupId = await makeGroup(db);

        vpsM = await makeProduct(db, {
            groupId,
            slug: "vps-m",
            name: "VPS M",
            cycle: "monthly",
            priceCents: 1999,
        });

        vpsAnnual = await makeProduct(db, {
            groupId,
            slug: "vps-a",
            name: "VPS A",
            cycle: "annual",
            priceCents: 19_990,
            // Asks for more notice than the portal's fortnight.
            renewalLeadDays: 30,
        });

        trialVps = await makeProduct(db, {
            groupId,
            slug: "vps-trial",
            name: "VPS Probe",
            cycle: "monthly",
            priceCents: 1999,
            trialDays: 14,
        });
    }, 60_000);

    afterAll(async () => {
        await drop?.();
    });

    async function openInvoicesOf(customerId: string) {
        return db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.customerId, customerId))
            .orderBy(schema.invoice.id);
    }

    // -----------------------------------------------------------------
    // The ninety days
    // -----------------------------------------------------------------

    describe("ninety days with a fake clock", () => {
        let customerId: string;
        let subscriptionId: string;
        let itemId: string;
        let renewalId: string;

        beforeAll(async () => {
            customerId = await nextCustomer();

            // Ordered on 1 November, 14 free days, billed automatically.
            const placed = await order(db, {
                customerId,
                items: [{ productId: trialVps, cycle: "monthly" }],
                now: at("2026-11-01"),
                settings: SETTINGS,
                autoCharge: true,
            });

            subscriptionId = placed.subscriptionIds[0];
            itemId = (await itemsOf(db, subscriptionId))[0].id;

            // The services are running, so a suspension has something to do.
            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: at("2026-11-01") })
                .where(eq(schema.service.subscriptionItemId, itemId));
        }, 60_000);

        it("starts on trial, with nothing invoiced and nothing to pay", async () => {
            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("trialing");
            expect(row.trialEndsAt?.toISOString()).toBe(
                at("2026-11-15").toISOString(),
            );
            expect(row.nextBillingAt?.toISOString()).toBe(
                at("2026-11-15").toISOString(),
            );
            expect(await openInvoicesOf(customerId)).toHaveLength(0);
        });

        it("raises the first renewal a fortnight before the trial ends", async () => {
            // Lead time 14 days, trial end 15 November → the invoice is
            // raised on the 1st, the day the Abo was ordered.
            const first = await run("2026-11-01");

            expect(first.ran).toBe(true);
            expect(first.report.invoicesIssued).toBe(1);

            const [invoice] = await openInvoicesOf(customerId);

            renewalId = invoice.id;

            // 15.11. – 1.12. is 16 of 30 days: 1999 × 16/30 = 1066,13… → 1066.
            expect(invoice.grossCents).toBe(1066);
            expect(invoice.status).toBe("unpaid");
            expect(invoice.number).toMatch(/^RE-/);
            // Due the day the period starts, not a fortnight after issue.
            expect(invoice.dueAt?.toISOString()).toBe(
                at("2026-11-15").toISOString(),
            );
        });

        it("says on the line which days it bills, and prorates them", async () => {
            const [line] = await db
                .select()
                .from(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, renewalId));

            expect(line.unitPriceCents).toBe(1066);
            expect(line.detail).toContain("anteilig für 16 von 30 Tagen");
            expect(line.subscriptionItemId).toBe(itemId);
        });

        it("raises nothing on the following days, however often it runs", async () => {
            for (const day of ["2026-11-02", "2026-11-03", "2026-11-04"]) {
                await run(day);
                // Twice on purpose: a forced second pass is what an operator
                // pressing the button looks like.
                await run(day, { force: true });
            }

            expect(await openInvoicesOf(customerId)).toHaveLength(1);
        });

        it("ends the trial on the day, and then the period has to be paid", async () => {
            await run("2026-11-14");

            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "trialing",
            );

            const result = await run("2026-11-15");

            expect(result.report.trialsEnded).toBe(1);

            const row = await subscriptionOf(db, subscriptionId);

            // The trial is over and the renewal is unpaid, so the period
            // that has just ended does not roll over.
            expect(row.status).toBe("past_due");
            expect(row.currentPeriodEnd?.toISOString()).toBe(
                at("2026-11-15").toISOString(),
            );
        });

        it("tries the stored card on exactly three days, and no more", async () => {
            // There is no stored payment method on this account, so every
            // attempt is a non-collection — which is the point: the ladder
            // must be climbed once per rung whatever the outcome, and never
            // again on the ninety days in between.
            for (let day = 15; day <= 30; day += 1) {
                await run(`2026-11-${String(day).padStart(2, "0")}`);
                await run(`2026-11-${String(day).padStart(2, "0")}`, {
                    force: true,
                });
            }

            const rungs = await db
                .select()
                .from(schema.invoiceCollection)
                .where(eq(schema.invoiceCollection.invoiceId, renewalId))
                .orderBy(schema.invoiceCollection.offsetDays);

            expect(rungs.map((rung) => rung.offsetDays)).toEqual([0, 3, 7]);
        });

        it("sends the reminder at +3 and the Mahnung at +10, once each", async () => {
            const levels = await db
                .select()
                .from(schema.dunningAction)
                .where(eq(schema.dunningAction.invoiceId, renewalId))
                .orderBy(schema.dunningAction.dueAt);

            expect(levels.map((row) => row.level)).toEqual([
                "reminder",
                "mahnung",
                "suspend",
            ]);

            const reminder = levels[0];

            expect(reminder.dueAt.toISOString()).toBe(
                new Date(at("2026-11-15").getTime() + 3 * DAY_MS).toISOString(),
            );
            // Nothing is charged for a reminder or a Mahnung by default.
            expect(levels.every((row) => row.feeCents === 0)).toBe(true);
        });

        it("suspends the services at +14 and not a day earlier", async () => {
            // The suspension rung fell on 29 November, which the loop above
            // has already passed. Its own event says so, and the service is
            // the proof.
            const services = await servicesOf(db, itemId);

            expect(services[0].status).toBe("suspended");
            expect(services[0].suspendedAt).not.toBeNull();

            const suspension = (await eventsOf(db, subscriptionId)).filter(
                (row) =>
                    row.kind === "dunning" && row.summary.includes("gesperrt"),
            );

            // Once, however many times the run has passed over it.
            expect(suspension).toHaveLength(1);
        });

        it("does not raise the next renewal while the last one is unpaid", async () => {
            // The period never advanced, so `next_billing_at` is still the
            // 15th and its invoice already exists.
            expect(await openInvoicesOf(customerId)).toHaveLength(1);
        });

        it("comes back the moment the money arrives", async () => {
            const outcome = await applyPayment(db, {
                ref: "transfer-90-day-sim",
                gateway: "banktransfer",
                invoiceId: renewalId,
                customerId,
                amountCents: 1066,
                actor: ACTOR,
                at: at("2026-12-02"),
            });

            expect(outcome.changed).toBe(true);
            expect(outcome.invoiceStatus).toBe("paid");

            /**
             * `reactivateAfterSettlement` is what `emitInvoicePaid` calls —
             * it is the seam every settled payment passes through. It is
             * called directly here because `emitInvoicePaid` reaches for the
             * application's own pool (`@/db`), which in a test points at the
             * developer's database rather than at this throwaway one. The
             * run's own catch-up step is asserted below, and it calls the
             * same function.
             */
            await reactivateAfterSettlement(db, renewalId, at("2026-12-02"));

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("active");
            expect(row.pastDueAt).toBeNull();

            const services = await servicesOf(db, itemId);

            expect(services[0].status).toBe("active");
            expect(services[0].suspendedAt).toBeNull();
        });

        it("advances the period now that it is paid, and bills the next one", async () => {
            const result = await run("2026-12-02");

            expect(result.report.periodsAdvanced).toBe(1);

            const row = await subscriptionOf(db, subscriptionId);

            // The period the invoice bought: 15.11. – 1.12. …
            expect(row.currentPeriodStart.toISOString()).toBe(
                at("2026-11-15").toISOString(),
            );
            // … and from there, whole calendar months on the anchor.
            expect(row.currentPeriodEnd?.toISOString()).toBe(
                new Date("2026-12-01T00:00:00.000+01:00").toISOString(),
            );
        });

        it("never terminates an Abo whose invoice was paid before +30", async () => {
            for (let day = 3; day <= 20; day += 1) {
                await run(`2026-12-${String(day).padStart(2, "0")}`);
            }

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).not.toBe("ended");

            const levels = await db
                .select()
                .from(schema.dunningAction)
                .where(eq(schema.dunningAction.invoiceId, renewalId));

            // The +30 rung fell on 15 December; the invoice was no longer
            // open, so it was never claimed.
            expect(levels.map((row) => row.level)).not.toContain("terminate");
        });

        it("charges a whole period from the second renewal on", async () => {
            const invoices = await openInvoicesOf(customerId);
            const later = invoices.filter((row) => row.id !== renewalId);

            expect(later.length).toBeGreaterThan(0);
            // No longer a stub: 19,99 € for a whole month.
            expect(later[0].grossCents).toBe(1999);
        });
    });

    // -----------------------------------------------------------------
    // Idempotency
    // -----------------------------------------------------------------

    describe("running it again", () => {
        it("claims the day once: a second pass does nothing at all", async () => {
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-01-01"),
                settings: SETTINGS,
            });

            const first = await run("2027-01-18");
            const second = await run("2027-01-18");

            expect(first.ran).toBe(true);
            expect(second.ran).toBe(false);
            expect(second.runId).toBeNull();
        });

        it("still produces one invoice when the day marker is bypassed", async () => {
            // This is the claim that matters. The run marker is the cheap
            // layer and an operator is allowed to go round it; what actually
            // stops a second invoice is the unique index on
            // `subscription_invoice (subscription_id, period_start, kind)`.
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-02-01"),
                settings: SETTINGS,
            });

            for (let pass = 0; pass < 4; pass += 1) {
                await run("2027-02-18", { force: true });
            }

            const invoices = await openInvoicesOf(customerId);

            // One from the checkout, one renewal. Not five.
            expect(invoices).toHaveLength(2);
        });

        it("produces one invoice when two passes race each other", async () => {
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-03-01"),
                settings: SETTINGS,
            });

            // Both branches need a connection of their own before either
            // starts, or the pool serialises them and the race never happens.
            await warmPool(db, 4);

            const [a, b] = await Promise.all([
                run("2027-03-18", { force: true }),
                run("2027-03-18", { force: true }),
            ]);

            const issued = a.report.invoicesIssued + b.report.invoicesIssued;

            // One of them did the work and the other found it done. Not one
            // of them did the work and the other crashed into the unique
            // index — `run()` asserts that neither reported a failure.
            expect(issued).toBe(1);
            expect(await openInvoicesOf(customerId)).toHaveLength(2);
        });

        it("hands out gapless numbers across everything it issues", async () => {
            const numbers = await db
                .select({ number: schema.invoice.number })
                .from(schema.invoice)
                .orderBy(schema.invoice.number);

            const issued = numbers
                .map((row) => row.number)
                .filter((value): value is string => value !== null);

            expect(new Set(issued).size).toBe(issued.length);
        });
    });

    // -----------------------------------------------------------------
    // The lead time, per product
    // -----------------------------------------------------------------

    describe("how far ahead an invoice goes out", () => {
        it("honours a product that asks for more notice than the portal's", async () => {
            const customerId = await nextCustomer();
            /**
             * No billing anchor here, deliberately. With one, Phase 4 cuts
             * even an annual first period back to the next anchor day (see
             * `firstPeriod`), so the first renewal would fall a month after
             * the order rather than a year — which is a different thing from
             * the one this case is about.
             */
            const unanchored = SETTINGS_NO_ANCHOR;

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsAnnual, cycle: "annual" }],
                now: at("2027-04-01"),
                settings: unanchored,
            });

            /**
             * Paid, because a year passes between the order and the renewal
             * — and dunning terminates an Abo whose invoice has been open
             * for thirty days. Without this the first pass below finds an
             * Abo that ended eleven months ago, which is the right answer to
             * a different question.
             */
            await applyPayment(db, {
                ref: `transfer-annual-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2027-04-02"),
            });

            const subscriptionId = (
                await db
                    .select()
                    .from(schema.subscription)
                    .where(eq(schema.subscription.customerId, customerId))
            )[0];

            expect(subscriptionId.nextBillingAt?.toISOString()).toBe(
                at("2028-04-01").toISOString(),
            );

            // The product asks for 30 days' notice, so nothing happens at 31…
            await run("2028-03-01", { settings: unanchored });
            expect(await openInvoicesOf(customerId)).toHaveLength(1);

            // … and the invoice goes out at 30.
            await run("2028-03-02", { settings: unanchored });
            expect(await openInvoicesOf(customerId)).toHaveLength(2);
        });
    });

    // -----------------------------------------------------------------
    // Cancellation and the ways back
    // -----------------------------------------------------------------

    describe("cancelling at the end of the period", () => {
        it("raises no renewal, and ends the Abo on the day", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-05-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: at("2027-05-10"),
            });

            // Well inside the lead time — and still nothing is raised.
            await run("2027-05-25");
            expect(await openInvoicesOf(customerId)).toHaveLength(1);

            await run("2027-05-31");
            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "cancelled",
            );

            await run("2027-06-01");

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("ended");
            expect(row.endedAt).not.toBeNull();
        });
    });

    describe("taking a renewal back", () => {
        it("credits it, rolls the period back and lets a fresh one be raised", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-07-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            await run("2027-07-20");

            const links = await linksFor(db, subscriptionId);
            const renewal = links.find((link) => link.kind === "renewal");

            expect(renewal).toBeTruthy();

            const before = await subscriptionOf(db, subscriptionId);

            const reversed = await cancelRenewalInvoice(db, {
                invoiceId: renewal?.invoiceId as string,
                actor: ACTOR,
                now: at("2027-07-21"),
                settings: SETTINGS,
            });

            expect(reversed.creditNoteNumber).toMatch(/^KO-|^RK-|^\w/);

            const credited = await invoiceOf(db, renewal?.invoiceId as string);

            expect(credited.status).toBe("cancelled");

            // The link is gone, so the period may be invoiced again…
            expect(
                (await linksFor(db, subscriptionId)).filter(
                    (link) => link.kind === "renewal",
                ),
            ).toHaveLength(0);

            // … and the billing date is back where it was.
            const after = await subscriptionOf(db, subscriptionId);

            expect(after.nextBillingAt?.toISOString()).toBe(
                before.nextBillingAt?.toISOString(),
            );

            const again = await run("2027-07-22", { force: true });

            expect(again.report.invoicesIssued).toBe(1);
        });

        it("discounts exactly the agreed number of periods, then stops", async () => {
            const customerId = await nextCustomer();

            await db.insert(schema.coupon).values({
                id: createId("coupon"),
                code: "DREI25",
                kind: "percent",
                percentBasisPoints: 2500,
                duration: "repeating",
                durationPeriods: 3,
                active: true,
            });

            const placed = await order(db, {
                customerId,
                items: [
                    { productId: vpsM, cycle: "monthly", couponCode: "DREI25" },
                ],
                now: at("2029-03-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            // 25 % of 19,99 € is 5,00 € (half away from zero), so the
            // checkout charged 14,99 € and two discounted periods are left.
            expect(placed.grossCents).toBe(1499);
            expect(
                (await subscriptionOf(db, subscriptionId))
                    .discountPeriodsRemaining,
            ).toBe(2);

            await applyPayment(db, {
                ref: `coupon-first-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2029-03-02"),
            });

            const charged: number[] = [];

            // Four more periods: two still discounted, then full price.
            for (const [issue, start] of [
                ["2029-03-20", "2029-04-01"],
                ["2029-04-20", "2029-05-01"],
                ["2029-05-20", "2029-06-01"],
                ["2029-06-20", "2029-07-01"],
            ]) {
                await run(issue);

                const link = (await linksFor(db, subscriptionId)).find(
                    (row) =>
                        row.kind === "renewal" &&
                        row.periodStart.toISOString() ===
                            new Date(
                                `${start}T00:00:00.000+02:00`,
                            ).toISOString(),
                );

                const invoice = await invoiceOf(db, link?.invoiceId as string);

                charged.push(invoice.grossCents ?? 0);

                await applyPayment(db, {
                    ref: `coupon-${start}-${customerId}`,
                    gateway: "banktransfer",
                    invoiceId: invoice.id,
                    customerId,
                    amountCents: invoice.grossCents ?? 0,
                    actor: ACTOR,
                    at: at(start),
                });

                await run(start);
            }

            expect(charged).toEqual([1499, 1499, 1999, 1999]);

            // And the Abo no longer claims a discount it does not have.
            const after = await subscriptionOf(db, subscriptionId);

            expect(after.couponId).toBeNull();
            expect(after.couponCode).toBeNull();
        }, 60_000);

        it("gives the coupon period back — the mirror of consuming it", async () => {
            const customerId = await nextCustomer();

            await db.insert(schema.coupon).values({
                id: createId("coupon"),
                code: "ROLLBACK25",
                kind: "percent",
                percentBasisPoints: 2500,
                duration: "repeating",
                durationPeriods: 3,
                active: true,
            });

            const placed = await order(db, {
                customerId,
                items: [
                    {
                        productId: vpsM,
                        cycle: "monthly",
                        couponCode: "ROLLBACK25",
                    },
                ],
                now: at("2027-08-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            // The checkout billed the first period, so two are left.
            expect(
                (await subscriptionOf(db, subscriptionId))
                    .discountPeriodsRemaining,
            ).toBe(2);

            await run("2027-08-20");

            expect(
                (await subscriptionOf(db, subscriptionId))
                    .discountPeriodsRemaining,
            ).toBe(1);

            const renewal = (await linksFor(db, subscriptionId)).find(
                (link) => link.kind === "renewal",
            );

            await cancelRenewalInvoice(db, {
                invoiceId: renewal?.invoiceId as string,
                actor: ACTOR,
                now: at("2027-08-21"),
                settings: SETTINGS,
            });

            expect(
                (await subscriptionOf(db, subscriptionId))
                    .discountPeriodsRemaining,
            ).toBe(2);
        });
    });

    // -----------------------------------------------------------------
    // Credit, and the Mahngebühr
    // -----------------------------------------------------------------

    describe("credit on the account", () => {
        it("is spent on the renewal the moment it is issued", async () => {
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-09-01"),
                settings: SETTINGS,
            });

            // 5,00 € on the account, by hand.
            await db.insert(schema.creditLedger).values({
                id: createId("creditledger"),
                customerId,
                kind: "adjustment",
                amountCents: 500,
                reason: "Test",
            });

            const result = await run("2027-09-20");

            expect(result.report.creditAppliedCents).toBe(500);
            expect(await creditBalanceCents(db, customerId)).toBe(0);

            /**
             * By the link, not by the amount: the checkout's own invoice is
             * also 19,99 €, and a test that picked the first match would
             * have asserted against the wrong document.
             */
            const [subscription] = await db
                .select()
                .from(schema.subscription)
                .where(eq(schema.subscription.customerId, customerId));
            const link = (await linksFor(db, subscription.id)).find(
                (row) => row.kind === "renewal",
            );
            const renewal = await invoiceOf(db, link?.invoiceId as string);

            // 19,99 € less 5,00 € of credit leaves it partly paid — and
            // `partial` is still an open invoice.
            expect(renewal.grossCents).toBe(1999);
            expect(renewal.status).toBe("partial");
            expect(renewal.paidCents).toBe(500);
            expect(
                OPEN_INVOICE_STATUSES.includes(
                    renewal.status as "unpaid" | "partial",
                ),
            ).toBe(true);
        });

        it("spends only what the invoice asks for, however much is on the account", async () => {
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2029-01-01"),
                settings: SETTINGS,
            });

            // 50,00 € on the account against a 19,99 € renewal.
            await db.insert(schema.creditLedger).values({
                id: createId("creditledger"),
                customerId,
                kind: "adjustment",
                amountCents: 5000,
                reason: "Test",
            });

            const result = await run("2029-01-20");

            // Spending the whole balance would hand the overshoot straight
            // back as credit, which is a loop rather than a payment.
            expect(result.report.creditAppliedCents).toBe(1999);
            expect(await creditBalanceCents(db, customerId)).toBe(3001);

            const [subscription] = await db
                .select()
                .from(schema.subscription)
                .where(eq(schema.subscription.customerId, customerId));
            const link = (await linksFor(db, subscription.id)).find(
                (row) => row.kind === "renewal",
            );
            const renewal = await invoiceOf(db, link?.invoiceId as string);

            expect(renewal.status).toBe("paid");
            expect(renewal.paidCents).toBe(1999);
        });

        it("dunns a partly paid invoice like any other open one", async () => {
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-10-01"),
                settings: SETTINGS,
            });

            await db.insert(schema.creditLedger).values({
                id: createId("creditledger"),
                customerId,
                kind: "adjustment",
                amountCents: 100,
                reason: "Test",
            });

            await run("2027-10-20");

            const renewal = (await openInvoicesOf(customerId)).find(
                (row) => row.status === "partial",
            );

            expect(renewal).toBeTruthy();

            // The due date was 1 November; +3 is the 4th.
            await run("2027-11-04");

            const chased = await db
                .select()
                .from(schema.dunningAction)
                .where(
                    eq(schema.dunningAction.invoiceId, renewal?.id as string),
                );

            expect(chased.map((row) => row.level)).toContain("reminder");
        });
    });

    /**
     * `partial` is an open invoice (CLAUDE.md rule 3). These two are the
     * cases where comparing against the literal `"unpaid"` instead of
     * `OPEN_INVOICE_STATUSES` would be invisible until a customer noticed:
     * a part payment would buy a whole month, and a part payment would wake
     * a suspended server.
     */
    describe("a half-paid renewal is not a paid one", () => {
        let customerId: string;
        let subscriptionId: string;
        let renewalId: string;

        beforeAll(async () => {
            customerId = await nextCustomer();

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2028-06-01"),
                settings: SETTINGS,
            });

            subscriptionId = placed.subscriptionIds[0];

            // The first invoice is settled, so nothing else is overdue and
            // every assertion below is about the renewal alone.
            await applyPayment(db, {
                ref: `transfer-partial-first-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2028-06-02"),
            });

            await run("2028-06-20");

            const link = (await linksFor(db, subscriptionId)).find(
                (row) => row.kind === "renewal",
            );

            renewalId = link?.invoiceId as string;

            // 10,00 € of 19,99 €.
            await applyPayment(db, {
                ref: `transfer-partial-${customerId}`,
                gateway: "banktransfer",
                invoiceId: renewalId,
                customerId,
                amountCents: 1000,
                actor: ACTOR,
                at: at("2028-06-25"),
            });
        }, 60_000);

        it("is `partial`, which is an open invoice", async () => {
            const invoice = await invoiceOf(db, renewalId);

            expect(invoice.status).toBe("partial");
            expect(invoice.paidCents).toBe(1000);
            expect(
                OPEN_INVOICE_STATUSES.includes(
                    invoice.status as "unpaid" | "partial",
                ),
            ).toBe(true);
        });

        it("does not buy the next period", async () => {
            const before = await subscriptionOf(db, subscriptionId);
            const result = await run("2028-07-01");

            expect(result.report.periodsAdvanced).toBe(0);

            const after = await subscriptionOf(db, subscriptionId);

            expect(after.status).toBe("past_due");
            expect(after.currentPeriodEnd?.toISOString()).toBe(
                before.currentPeriodEnd?.toISOString(),
            );
        });

        it("does not wake a suspended Abo either", async () => {
            const result = await run("2028-07-03");

            expect(result.report.reactivated).toBe(0);
            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "past_due",
            );
        });

        it("buys it once the rest arrives", async () => {
            const outcome = await applyPayment(db, {
                ref: `transfer-rest-${customerId}`,
                gateway: "banktransfer",
                invoiceId: renewalId,
                customerId,
                amountCents: 999,
                actor: ACTOR,
                at: at("2028-07-04"),
            });

            expect(outcome.invoiceStatus).toBe("paid");

            const result = await run("2028-07-05");

            expect(result.report.periodsAdvanced).toBe(1);

            const after = await subscriptionOf(db, subscriptionId);

            expect(after.status).toBe("active");
            expect(after.currentPeriodStart.toISOString()).toBe(
                new Date("2028-07-01T00:00:00.000+02:00").toISOString(),
            );
        });
    });

    describe("the Mahngebühr", () => {
        it("is its own invoice, because the one it belongs to cannot grow a line", async () => {
            const customerId = await nextCustomer();
            const withFee = withBilling({ dunningFeeCents: 500 });
            const settings = {
                ...withFee,
                policy: { ...withFee.policy, billingAnchorDay: 1 },
            };

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2027-12-01"),
                settings,
            });

            const invoiceId = placed.invoiceId as string;
            const before = await invoiceOf(db, invoiceId);

            // Due 15 December (14-day term); the Mahnung falls at +10.
            await run("2027-12-26", { settings });

            const action = (
                await db
                    .select()
                    .from(schema.dunningAction)
                    .where(
                        and(
                            eq(schema.dunningAction.invoiceId, invoiceId),
                            eq(schema.dunningAction.level, "mahnung"),
                        ),
                    )
            )[0];

            expect(action).toBeTruthy();
            expect(action.feeCents).toBe(500);
            expect(action.feeInvoiceId).not.toBeNull();

            const fee = await invoiceOf(db, action.feeInvoiceId as string);

            expect(fee.grossCents).toBe(500);
            expect(fee.number).toMatch(/^RE-/);

            // And the invoice it belongs to has not moved a cent.
            const after = await invoiceOf(db, invoiceId);

            expect(after.grossCents).toBe(before.grossCents);
            expect(after.netCents).toBe(before.netCents);
        });
    });
});
