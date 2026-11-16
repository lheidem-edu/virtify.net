import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runBilling } from "@/server/billing/run";
import { dispatchEvents } from "@/server/events/dispatch";
import { emitEvent, pendingEvents } from "@/server/events/emit";
import {
    CLAIM_TIMEOUT_MS,
    claimMail,
    expireStaleClaims,
    mailBackoffSeconds,
    queueMail,
    resendMail,
    runMailOutbox,
} from "@/server/mail/outbox";
import { runMailPass } from "@/server/mail/run";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";
import {
    anchored,
    makeCustomer,
    makeGroup,
    makeProduct,
    order,
} from "../helpers/fixtures";
import { fakeTransport } from "../helpers/mail";

/**
 * The event bus and the outbox, against a real Postgres.
 *
 * Every claim in this file is a claim about what rows a *transaction* leaves
 * behind — "emitted twice, one row", "dispatched twice, one mail", "sent and
 * not recorded, never retried" — and a mock cannot be wrong about a unique
 * index the way Postgres can. Phase 6 shipped a day-scoped claim taken by a
 * customer-scoped pass and Phase 7 shipped a per-mailbox claim behind an
 * installation-wide index; both passed their own suites.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the notification proofs are being\n" +
            "        SKIPPED. Run `npm run db:up`.\n",
    );
}

const SETTINGS = anchored(1);
const NOW = new Date("2026-11-20T09:00:00.000Z");

const SITE = { siteUrl: "https://virtify.test", siteName: "virtify.net" };

describe.skipIf(!available)("the event bus", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let groupId: string;
    let vpsM: string;
    let seq = 70_000;

    async function nextCustomer() {
        seq += 1;
        return makeCustomer(db, seq);
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
    });

    afterAll(async () => {
        await drop();
    });

    /* -------------------------------------------------------------- */
    /* Emitting                                                        */
    /* -------------------------------------------------------------- */

    it("writes nothing when the transaction that made the fact true rolls back", async () => {
        const customerId = await nextCustomer();

        await expect(
            db.transaction(async (tx) => {
                await emitEvent(tx, {
                    type: "customer.registered",
                    dedupeKey: `customer:${customerId}`,
                    entityType: "customer",
                    entityId: customerId,
                    customerId,
                    payload: {
                        customerNumber: 1,
                        name: "Kunde",
                        email: "k@example.test",
                    },
                });

                // Whatever came after the emit failed. The fact never
                // happened, so neither did the event.
                throw new Error("rolled back");
            }),
        ).rejects.toThrow("rolled back");

        const rows = await db
            .select()
            .from(schema.domainEvent)
            .where(eq(schema.domainEvent.customerId, customerId));

        expect(rows).toHaveLength(0);
    });

    it("emits the same fact twice as one row", async () => {
        const customerId = await nextCustomer();

        const first = await db.transaction((tx) =>
            emitEvent(tx, {
                type: "invoice.paid",
                dedupeKey: "invoice:double",
                entityType: "invoice",
                entityId: "invoice_double",
                customerId,
                payload: {
                    number: "RE-1",
                    grossCents: 1999,
                    currency: "EUR",
                    paidAt: NOW.toISOString(),
                },
            }),
        );

        const second = await db.transaction((tx) =>
            emitEvent(tx, {
                type: "invoice.paid",
                dedupeKey: "invoice:double",
                entityType: "invoice",
                entityId: "invoice_double",
                customerId,
                payload: {
                    number: "RE-1",
                    grossCents: 1999,
                    currency: "EUR",
                    paidAt: NOW.toISOString(),
                },
            }),
        );

        // The first writer gets the id; the second is told somebody else did
        // it. That is how a webhook and a daily pass can both be right.
        expect(first).not.toBeNull();
        expect(second).toBeNull();

        const rows = await db
            .select()
            .from(schema.domainEvent)
            .where(eq(schema.domainEvent.dedupeKey, "invoice:double"));

        expect(rows).toHaveLength(1);
    });

    it("refuses a payload that does not match its schema", async () => {
        await expect(
            db.transaction((tx) =>
                emitEvent(tx, {
                    type: "invoice.paid",
                    dedupeKey: "invoice:bad",
                    entityType: "invoice",
                    entityId: "invoice_bad",
                    customerId: null,
                    // grossCents must be an integer: a float here would reach
                    // a mail as "19,994999999 €".
                    payload: {
                        number: "RE-1",
                        grossCents: 19.99,
                        currency: "EUR",
                        paidAt: NOW.toISOString(),
                    } as never,
                }),
            ),
        ).rejects.toThrow();
    });

    /* -------------------------------------------------------------- */
    /* Dispatching                                                     */
    /* -------------------------------------------------------------- */

    it("turns one event into one mail, however many passes see it", async () => {
        const customerId = await nextCustomer();

        await db.transaction((tx) =>
            emitEvent(tx, {
                type: "customer.registered",
                dedupeKey: `customer:${customerId}`,
                entityType: "customer",
                entityId: customerId,
                customerId,
                payload: {
                    customerNumber: seq,
                    name: "Kundin",
                    email: `kunde${seq}@example.test`,
                },
            }),
        );

        const first = await dispatchEvents(db, {
            now: NOW,
            settings: SETTINGS,
        });
        const second = await dispatchEvents(db, {
            now: NOW,
            settings: SETTINGS,
        });

        expect(first.queued).toBeGreaterThanOrEqual(1);
        // The second pass finds nothing pending at all — the event is
        // `dispatched` — which is the cheap layer. The unique index below is
        // what would stop it even if the status were wrong.
        expect(second.dispatched).toBe(0);

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(eq(schema.emailLog.customerId, customerId));

        expect(mails).toHaveLength(1);
        expect(mails[0].template).toBe("welcome");
        expect(mails[0].dedupeKey).toBe(`customer:${customerId}`);
        expect(mails[0].status).toBe("pending");
    });

    it("finishes a fan-out that was interrupted, without sending it again", async () => {
        const customerId = await nextCustomer();

        // Two contacts who both want billing mail.
        const userId = `user_${seq}b`;
        await db.insert(schema.user).values({
            id: userId,
            name: "Zweiter Kontakt",
            email: `zweiter${seq}@example.test`,
            emailVerified: true,
        });
        await db.insert(schema.customerContact).values({
            customerId,
            userId,
            role: "contact",
            email: `zweiter${seq}@example.test`,
            canBilling: true,
        });

        await db.transaction((tx) =>
            emitEvent(tx, {
                type: "customer.registered",
                dedupeKey: `customer:${customerId}`,
                entityType: "customer",
                entityId: customerId,
                customerId,
                payload: {
                    customerNumber: seq,
                    name: "Kundin",
                    email: `kunde${seq}@example.test`,
                },
            }),
        );

        const [event] = await pendingEvents(db, { now: NOW });

        // Pretend the first of the two rows was written and the pass then
        // died: queue it by hand, leave the event pending, and dispatch.
        await db.transaction((tx) =>
            queueMail(tx, {
                template: "welcome",
                dedupeKey: `customer:${customerId}`,
                toEmail: `kunde${seq}@example.test`,
                customerId,
                eventId: event.id,
                entityType: "customer",
                entityId: customerId,
                payload: { ...SITE, name: "Kundin", customerNumber: seq },
            }),
        );

        await dispatchEvents(db, { now: NOW, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(eq(schema.emailLog.customerId, customerId));

        // Two addresses, two rows, and the one that already existed was not
        // written twice. The `on conflict` is doing the work, not the status.
        expect(mails).toHaveLength(2);
        expect(new Set(mails.map((row) => row.toEmail)).size).toBe(2);
    });

    /* -------------------------------------------------------------- */
    /* Sending                                                         */
    /* -------------------------------------------------------------- */

    describe("the outbox", () => {
        let customerId: string;

        beforeEach(async () => {
            /**
             * The sweep drains the *whole* table, which is what it is for —
             * so these cases start from an empty one. Without this they pass
             * or fail depending on what the cases above them left behind,
             * which is the kind of test that stops meaning anything.
             */
            await db.delete(schema.emailLog);
            await db.delete(schema.domainEvent);

            customerId = await nextCustomer();

            await db.transaction((tx) =>
                queueMail(tx, {
                    template: "welcome",
                    dedupeKey: `customer:${customerId}`,
                    toEmail: `kunde${seq}@example.test`,
                    customerId,
                    entityType: "customer",
                    entityId: customerId,
                    payload: { ...SITE, name: "Kundin", customerNumber: seq },
                }),
            );
        });

        async function rowFor(id: string) {
            const [row] = await db
                .select()
                .from(schema.emailLog)
                .where(eq(schema.emailLog.customerId, id))
                .limit(1);

            return row;
        }

        it("sends it, records what went out, and does not send it again", async () => {
            const transport = fakeTransport();

            const first = await runMailOutbox(db, {
                now: NOW,
                transport,
                settings: SETTINGS,
            });

            expect(first.sent).toBe(1);
            expect(transport.sent).toHaveLength(1);
            expect(transport.sent[0].subject).toContain("Willkommen");

            const row = await rowFor(customerId);

            expect(row.status).toBe("sent");
            expect(row.sentAt).not.toBeNull();
            expect(row.messageId).toBe("<1@virtify.test>");
            expect(row.transport).toBe("smtp");
            // The subject and the text part as delivered — the record a person
            // reading the log actually reads.
            expect(row.subject).toContain("Willkommen");
            expect(row.bodyText).toContain("Hallo Kundin,");

            const second = await runMailOutbox(db, {
                now: NOW,
                transport,
                settings: SETTINGS,
            });

            expect(second.sent).toBe(0);
            expect(transport.sent).toHaveLength(1);
        });

        it("accepts a transport that reports no Message-ID", async () => {
            const transport = fakeTransport("graph");
            transport.reportNoMessageId = true;

            await runMailOutbox(db, {
                now: NOW,
                transport,
                settings: SETTINGS,
            });

            const row = await rowFor(customerId);

            // Graph answers `202 Accepted` with an empty body. Nothing may be
            // keyed on the id being there — Phase 7 keyed a parse on 204 and
            // threw *after the mail had gone out*.
            expect(row.status).toBe("sent");
            expect(row.messageId).toBeNull();
            expect(row.transport).toBe("graph");
        });

        it("burns no attempt when there is no way out of the building", async () => {
            // This installation's normal state: no SMTP relay, no tenant.
            const report = await runMailOutbox(db, {
                now: NOW,
                transport: null,
                settings: SETTINGS,
            });

            expect(report.skipped).toBe(1);
            expect(report.sent).toBe(0);

            const row = await rowFor(customerId);

            // Still runnable, with its whole ladder. "There is no relay
            // configured" is not a property of the message.
            expect(row.status).toBe("pending");
            expect(row.attempts).toBe(0);
        });

        it("retries a send that threw, with a backoff", async () => {
            const transport = fakeTransport();
            transport.failWith = "550 Mailbox unavailable";

            const report = await runMailOutbox(db, {
                now: NOW,
                transport,
                settings: SETTINGS,
            });

            expect(report.failed).toBe(1);

            const row = await rowFor(customerId);

            expect(row.status).toBe("failed");
            expect(row.attempts).toBe(1);
            expect(row.lastError).toContain("550");
            // `failed` is runnable, so a "permanent" failure without a backoff
            // would be retried a minute later — Phase 8 shipped exactly that.
            expect(row.runAfter).not.toBeNull();
            expect(row.runAfter?.getTime()).toBe(
                NOW.getTime() + mailBackoffSeconds(1) * 1_000,
            );

            // Still inside the backoff: the same pass finds nothing due.
            const again = await runMailOutbox(db, {
                now: NOW,
                transport,
                settings: SETTINGS,
            });

            expect(again.sent).toBe(0);

            // Past it: it goes out.
            const later = await runMailOutbox(db, {
                now: new Date(NOW.getTime() + 120_000),
                transport,
                settings: SETTINGS,
            });

            expect(later.sent).toBe(1);
        });

        it("gives up at the end of its ladder instead of waiting for ever", async () => {
            const transport = fakeTransport();
            let at = NOW;

            for (let i = 0; i < 5; i += 1) {
                transport.failWith = "connection refused";
                await runMailOutbox(db, {
                    now: at,
                    transport,
                    settings: SETTINGS,
                });
                at = new Date(at.getTime() + 2 * 3_600_000);
            }

            const row = await rowFor(customerId);

            expect(row.attempts).toBe(5);
            expect(row.status).toBe("abandoned");
            // `abandoned` and not `failed`: a row the sweep reads sixty times
            // an hour and can never act on is a row nobody looks at.
            expect(row.runAfter).toBeNull();
        });

        it("leaves a mail that was sent but not recorded as `unknown`, and never retries it", async () => {
            const transport = fakeTransport();
            const row = await rowFor(customerId);

            // The send returns and the recording fails. Arranged by claiming
            // the row ourselves first, which is what a process that died
            // between the two would have left behind.
            await claimMail(db, row.id, NOW);

            // The claim is older than the timeout: this is the state the
            // crashed process left.
            await db
                .update(schema.emailLog)
                .set({
                    claimedAt: new Date(
                        NOW.getTime() - CLAIM_TIMEOUT_MS - 1_000,
                    ),
                })
                .where(eq(schema.emailLog.id, row.id));

            const report = await runMailOutbox(db, {
                now: NOW,
                transport,
                settings: SETTINGS,
            });

            expect(report.expired).toBe(1);
            expect(transport.sent).toHaveLength(0);

            const after = await rowFor(customerId);

            // **Not `pending`.** The customer may be holding that mail, and a
            // mail has no provider-side id to ask about — there is no "does VM
            // 101 exist" for a message. An operator decides.
            expect(after.status).toBe("unknown");
            expect(after.lastError).toContain("nicht feststellbar");

            // And a later pass leaves it exactly where it is.
            const later = await runMailOutbox(db, {
                now: new Date(NOW.getTime() + 3_600_000),
                transport,
                settings: SETTINGS,
            });

            expect(later.sent).toBe(0);
            expect((await rowFor(customerId)).status).toBe("unknown");
        });

        it("refuses a second claim on a row somebody else is sending", async () => {
            const row = await rowFor(customerId);

            expect(await claimMail(db, row.id, NOW)).toBe(true);
            // The conditional update *is* the claim: the loser's
            // `status in ('pending','failed')` is no longer true.
            expect(await claimMail(db, row.id, NOW)).toBe(false);
        });

        it("refuses a claim on a row whose ladder has run out", async () => {
            const row = await rowFor(customerId);

            await db
                .update(schema.emailLog)
                .set({ status: "failed", attempts: 5, maxAttempts: 5 })
                .where(eq(schema.emailLog.id, row.id));

            expect(await claimMail(db, row.id, NOW)).toBe(false);
        });

        it("sends one mail for a double-clicked resend", async () => {
            const transport = fakeTransport();
            await runMailOutbox(db, {
                now: NOW,
                transport,
                settings: SETTINGS,
            });

            const original = await rowFor(customerId);

            const first = await resendMail(db, {
                id: original.id,
                expectedResendCount: 0,
            });
            // The second click carries the same stale number and loses.
            const second = await resendMail(db, {
                id: original.id,
                expectedResendCount: 0,
            });

            expect(first).not.toBeNull();
            expect(second).toBeNull();

            const rows = await db
                .select()
                .from(schema.emailLog)
                .where(eq(schema.emailLog.customerId, customerId));

            // A resend is a *new* row: the record of a mail that left the
            // building is never rewritten.
            expect(rows).toHaveLength(2);
            const resent = rows.find((entry) => entry.id === first);
            expect(resent?.resendOfId).toBe(original.id);
            expect(resent?.dedupeKey).toBe(`resend:${original.id}:1`);
            expect(rows.find((entry) => entry.id === original.id)?.status).toBe(
                "sent",
            );

            // A deliberate second resend, with the number the page now shows.
            const third = await resendMail(db, {
                id: original.id,
                expectedResendCount: 1,
            });

            expect(third).not.toBeNull();
        });

        it("expires only claims that are actually stale", async () => {
            const row = await rowFor(customerId);
            await claimMail(db, row.id, NOW);

            // A send in flight, a minute old. Expiring it would be the worst
            // possible answer: it would declare a live send unresolvable.
            expect(
                await expireStaleClaims(db, new Date(NOW.getTime() + 60_000)),
            ).toBe(0);
            expect((await rowFor(customerId)).status).toBe("sending");
        });
    });

    /* -------------------------------------------------------------- */
    /* End to end, through the real emitters                           */
    /* -------------------------------------------------------------- */

    it("notices one invoice once, with the stored PDF attached", async () => {
        const customerId = await nextCustomer();

        const placed = await order(db, {
            customerId,
            items: [{ productId: vpsM, cycle: "monthly" }],
            now: NOW,
            settings: SETTINGS,
        });

        expect(placed.invoiceId).not.toBeNull();

        const events = await db
            .select()
            .from(schema.domainEvent)
            .where(eq(schema.domainEvent.customerId, customerId));

        const issued = events.filter((row) => row.type === "invoice.issued");
        const ordered = events.filter((row) => row.type === "order.placed");

        // Both emitted inside `placeOrder`'s one transaction, which is the
        // only place they could be: the order, the Abo, the service and the
        // first invoice are written together or not at all.
        expect(issued).toHaveLength(1);
        expect(ordered).toHaveLength(1);
        expect(issued[0].dedupeKey).toBe(`invoice:${placed.invoiceId}`);
        expect((issued[0].payload as { reason: string }).reason).toBe("order");

        const transport = fakeTransport();
        await runMailPass(db, { now: NOW });
        await runMailOutbox(db, { now: NOW, transport, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(
                and(
                    eq(schema.emailLog.customerId, customerId),
                    eq(schema.emailLog.template, "invoice.notice"),
                ),
            );

        expect(mails).toHaveLength(1);

        /**
         * Nothing has rendered the PDF in this test, so `pdf_key` is null and
         * the notice goes out *without* an attachment and without the
         * sentence that claims one — the portal link is what it carries. That
         * is the right answer for a renewal raised by the worker, which
         * cannot render a document at all; the document is rendered on first
         * access.
         *
         * The other case — a key that *is* set and has no object behind it —
         * is the next test, and it defers rather than sending.
         */
        expect(mails[0].status).toBe("sent");

        const notice = transport.sent.find((message) =>
            String(message.subject).includes("Rechnung"),
        );

        expect(notice).toBeDefined();
        expect(notice?.attachments ?? []).toHaveLength(0);
        expect(String(notice?.text)).not.toContain("als PDF bei");
    });

    it("counts an attempt for a document that never arrives, so it cannot spin for ever", async () => {
        const customerId = await nextCustomer();

        await db.transaction((tx) =>
            queueMail(tx, {
                template: "invoice.notice",
                dedupeKey: "invoice:ghost",
                toEmail: `kunde${seq}@example.test`,
                customerId,
                entityType: "invoice",
                entityId: "invoice_ghost",
                payload: {
                    ...SITE,
                    invoiceId: "invoice_ghost",
                    number: "RE-GHOST",
                    grossCents: 1999,
                    currency: "EUR",
                    dueAt: NOW.toISOString(),
                    reason: "renewal",
                    autoCharge: false,
                    pdfKey: "invoices/does-not-exist.pdf",
                },
            }),
        );

        const transport = fakeTransport();
        const report = await runMailOutbox(db, {
            now: NOW,
            transport,
            settings: SETTINGS,
        });

        expect(report.failed).toBe(1);
        expect(transport.sent).toHaveLength(0);

        const [row] = await db
            .select()
            .from(schema.emailLog)
            .where(eq(schema.emailLog.dedupeKey, "invoice:ghost"));

        expect(row.attempts).toBe(1);
        expect(row.lastError).toContain("noch nicht im Speicher");
    });

    it("keys a dunning notice on the rung, which is claimed once for ever", async () => {
        const customerId = await nextCustomer();

        const placed = await order(db, {
            customerId,
            items: [{ productId: vpsM, cycle: "monthly" }],
            now: NOW,
            settings: SETTINGS,
        });

        const invoiceId = placed.invoiceId as string;

        // One rung, claimed by hand the way `actOnDunningRung` does.
        const [action] = await db
            .insert(schema.dunningAction)
            .values({
                invoiceId,
                customerId,
                level: "mahnung",
                dueAt: NOW,
                actedAt: NOW,
            })
            .returning({ id: schema.dunningAction.id });

        for (let i = 0; i < 2; i += 1) {
            await db.transaction((tx) =>
                emitEvent(tx, {
                    type: "dunning.reached",
                    dedupeKey: `dunning:${action.id}`,
                    entityType: "dunning_action",
                    entityId: action.id,
                    customerId,
                    payload: {
                        level: "mahnung",
                        invoiceId,
                        invoiceNumber: "RE-2026-0001",
                        outstandingCents: 1999,
                        currency: "EUR",
                        dueAt: NOW.toISOString(),
                        feeCents: 500,
                    },
                }),
            );
        }

        await dispatchEvents(db, { now: NOW, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(
                and(
                    eq(schema.emailLog.customerId, customerId),
                    eq(schema.emailLog.template, "dunning"),
                ),
            );

        expect(mails).toHaveLength(1);
        expect(mails[0].dedupeKey).toBe(`dunning:${action.id}`);

        const transport = fakeTransport();
        await runMailOutbox(db, { now: NOW, transport, settings: SETTINGS });

        const sent = transport.sent.find((message) =>
            String(message.subject).includes("Mahnung"),
        );

        expect(sent).toBeDefined();
        // The fee *this rung* raised, not whatever the setting says today.
        expect(String(sent?.text)).toContain("5,00");
    });

    it("announces a trial end once, and announces a moved one again", async () => {
        const customerId = await nextCustomer();
        const trialVps = await makeProduct(db, {
            groupId,
            slug: `vps-trial-${seq}`,
            name: "VPS mit Testphase",
            cycle: "monthly",
            priceCents: 3999,
            trialDays: 14,
        });

        const placed = await order(db, {
            customerId,
            items: [{ productId: trialVps, cycle: "monthly" }],
            now: new Date("2026-11-01T09:00:00.000Z"),
            settings: SETTINGS,
        });

        const subscriptionId = placed.subscriptionIds[0];

        async function noticesFor(id: string) {
            return db
                .select()
                .from(schema.domainEvent)
                .where(
                    and(
                        eq(schema.domainEvent.entityId, id),
                        eq(
                            schema.domainEvent.type,
                            "subscription.trial_ending",
                        ),
                    ),
                );
        }

        const pass = (day: string, force: boolean) =>
            runBilling(db, {
                now: new Date(`${day}T09:00:00.000Z`),
                settings: SETTINGS,
                force,
                customerId,
                renderPdf: false,
            });

        // Two passes inside the notice window. The second has to find the
        // claim taken — this used to be a `select` for a note with a
        // particular summary, which two passes racing would both miss.
        const first = await pass("2026-11-10", false);
        const second = await pass("2026-11-11", true);

        const once = await noticesFor(subscriptionId);

        expect(once).toHaveLength(1);
        expect(once[0].dedupeKey).toContain("2026-11-15");

        /**
         * **The emit is the claim for the whole step**, not only for the
         * event. The pass that loses it writes no timeline entry and counts
         * nothing — otherwise the Abo's own history grows a duplicate
         * "Hinweis verschickt" every night and the run's report says it told
         * the customer twice.
         */
        expect(first.report.trialNoticesSent).toBe(1);
        expect(second.report.trialNoticesSent).toBe(0);

        const notes = await db
            .select()
            .from(schema.subscriptionEvent)
            .where(
                and(
                    eq(schema.subscriptionEvent.subscriptionId, subscriptionId),
                    eq(
                        schema.subscriptionEvent.summary,
                        "Hinweis auf das Ende der Testphase verschickt.",
                    ),
                ),
            );

        expect(notes).toHaveLength(1);

        /**
         * A plan change moves the end of the trial. That is a **different**
         * notice and the customer has to hear about it — which is why the
         * date is in the key and the subscription id alone is not. Without
         * it, the second notice is silenced for ever.
         */
        await db
            .update(schema.subscription)
            .set({ trialEndsAt: new Date("2026-11-25T00:00:00.000Z") })
            .where(eq(schema.subscription.id, subscriptionId));

        await pass("2026-11-12", true);

        const twice = await noticesFor(subscriptionId);

        expect(twice).toHaveLength(2);
        expect(new Set(twice.map((row) => row.dedupeKey)).size).toBe(2);

        /**
         * The renewal the pass raised says so. „Ihre Verlängerung" and „hier
         * ist Rechnung 2026-0041" are one message about one document, and the
         * reason is what decides which of the four it is — a renewal notice
         * that read as a first invoice would tell a customer to pay for an
         * order they never placed.
         */
        const renewals = await db
            .select()
            .from(schema.domainEvent)
            .where(
                and(
                    eq(schema.domainEvent.customerId, customerId),
                    eq(schema.domainEvent.type, "invoice.issued"),
                ),
            );

        const reasons = renewals.map(
            (row) => (row.payload as { reason: string }).reason,
        );

        // A trial order charges nothing, so there is no first invoice at all
        // here — the only document is the renewal, which is the point.
        expect(reasons).toEqual(["renewal"]);
    });

    it("notifies only the people the staff reply did not already reach", async () => {
        const customerId = await nextCustomer();
        const owner = `kunde${seq}@example.test`;

        const secondId = `user_${seq}k`;
        await db.insert(schema.user).values({
            id: secondId,
            name: "Nur im Portal",
            email: `portal${seq}@example.test`,
            emailVerified: true,
        });
        await db.insert(schema.customerContact).values({
            customerId,
            userId: secondId,
            role: "contact",
            email: `portal${seq}@example.test`,
            canTickets: true,
        });

        await db.transaction((tx) =>
            emitEvent(tx, {
                type: "ticket.replied",
                dedupeKey: "ticketmessage:reply-1",
                entityType: "ticket_message",
                entityId: "ticketmessage_reply1",
                customerId,
                payload: {
                    ticketId: "ticket_1",
                    number: 4711,
                    subject: "Server antwortet nicht",
                    author: "staff",
                    // The reply itself went out by mail to the owner, in the
                    // original thread, with the answer in it.
                    notifiedEmails: [owner],
                },
            }),
        );

        await dispatchEvents(db, { now: NOW, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(
                and(
                    eq(schema.emailLog.customerId, customerId),
                    eq(schema.emailLog.template, "ticket.replied"),
                ),
            );

        /**
         * One mail, to the contact the thread does not carry. The owner got
         * the answer; a second message with only a link in it would read as a
         * second answer.
         */
        expect(mails).toHaveLength(1);
        expect(mails[0].toEmail).toBe(`portal${seq}@example.test`);
    });

    it("sends no receipt for a payment against a corrected document", async () => {
        const customerId = await nextCustomer();

        const received = (invoiceStatus: string, key: string) =>
            db.transaction((tx) =>
                emitEvent(tx, {
                    type: "payment.received",
                    dedupeKey: key,
                    entityType: "payment",
                    entityId: key,
                    customerId,
                    payload: {
                        amountCents: 1999,
                        currency: "EUR",
                        provider: "banktransfer",
                        purpose: "invoice",
                        invoiceId: null,
                        invoiceNumber: "RE-CANCELLED",
                        outstandingCents: 0,
                        invoiceStatus,
                    },
                }),
            );

        await received("cancelled", "payment:on-cancelled");
        await received("paid", "payment:on-paid");

        await dispatchEvents(db, { now: NOW, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(
                and(
                    eq(schema.emailLog.customerId, customerId),
                    eq(schema.emailLog.template, "payment.received"),
                ),
            );

        /**
         * The money is recorded either way and it still becomes credit — but
         * what a payment against a document that was taken back *means* is a
         * decision the operator makes (AGB § 8), and "die Rechnung ist damit
         * ausgeglichen" about a cancelled invoice would be wrong in both
         * directions.
         */
        expect(mails).toHaveLength(1);
        // The mail's key is the notifier's own — `payment:<the payment row>`
        // — and the event's entity id here *is* that row, so the two nest.
        expect(mails[0].dedupeKey).toBe("payment:payment:on-paid");

        // Both facts are still on the bus: Phase 10's webhooks want them.
        const events = await db
            .select()
            .from(schema.domainEvent)
            .where(eq(schema.domainEvent.customerId, customerId));

        expect(events).toHaveLength(2);
        expect(events.every((row) => row.status === "dispatched")).toBe(true);
    });

    it("sends a receipt to the address the invoice itself names", async () => {
        const customerId = await nextCustomer();

        const placed = await order(db, {
            customerId,
            items: [{ productId: vpsM, cycle: "monthly" }],
            now: NOW,
            settings: SETTINGS,
        });

        const invoiceId = placed.invoiceId as string;

        /**
         * The contact has since moved. The invoice's `buyer_email` is a
         * snapshot taken when it was finalized, and a receipt is *about that
         * document* — rule 3 in a different costume: a finalized invoice does
         * not change, including in who it was for.
         */
        await db
            .update(schema.customerContact)
            .set({ email: `umgezogen${seq}@example.test` })
            .where(eq(schema.customerContact.customerId, customerId));

        await db.transaction((tx) =>
            emitEvent(tx, {
                type: "payment.received",
                dedupeKey: `payment:frozen-${seq}`,
                entityType: "payment",
                entityId: `payment_frozen_${seq}`,
                customerId,
                payload: {
                    amountCents: 1999,
                    currency: "EUR",
                    provider: "banktransfer",
                    purpose: "invoice",
                    invoiceId,
                    invoiceNumber: "RE-FROZEN",
                    outstandingCents: 0,
                    invoiceStatus: "paid",
                },
            }),
        );

        await dispatchEvents(db, { now: NOW, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(
                and(
                    eq(schema.emailLog.customerId, customerId),
                    eq(schema.emailLog.template, "payment.received"),
                ),
            );

        const [invoice] = await db
            .select({ buyerEmail: schema.invoice.buyerEmail })
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoiceId));

        expect(invoice.buyerEmail).not.toBeNull();
        expect(mails).toHaveLength(1);
        expect(mails[0].toEmail).toBe(invoice.buyerEmail);
        expect(mails[0].toEmail).not.toContain("umgezogen");
    });

    it("says nothing to a closed account", async () => {
        const customerId = await nextCustomer();

        await db
            .update(schema.customer)
            .set({ status: "closed" })
            .where(eq(schema.customer.id, customerId));

        await db.transaction((tx) =>
            emitEvent(tx, {
                type: "customer.registered",
                dedupeKey: `customer:${customerId}`,
                entityType: "customer",
                entityId: customerId,
                customerId,
                payload: {
                    customerNumber: seq,
                    name: "Kundin",
                    email: `kunde${seq}@example.test`,
                },
            }),
        );

        await dispatchEvents(db, { now: NOW, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(eq(schema.emailLog.customerId, customerId));

        // A closed account is closed because nothing runs any more or because
        // it was anonymised — and in the second case the address is no longer
        // a person's.
        expect(mails).toHaveLength(0);

        // The event is still marked dealt with: there was nothing to do, and
        // leaving it pending would read it sixty times an hour for ever.
        const [event] = await db
            .select()
            .from(schema.domainEvent)
            .where(eq(schema.domainEvent.customerId, customerId));

        expect(event.status).toBe("dispatched");
    });

    it("respects what each contact is on the account for", async () => {
        const customerId = await nextCustomer();

        const technicalId = `user_${seq}t`;
        await db.insert(schema.user).values({
            id: technicalId,
            name: "Technik",
            email: `technik${seq}@example.test`,
            emailVerified: true,
        });
        await db.insert(schema.customerContact).values({
            customerId,
            userId: technicalId,
            role: "contact",
            email: `technik${seq}@example.test`,
            // Technical only: this person does not get invoices.
            canBilling: false,
            canTechnical: true,
            canTickets: false,
        });

        await db.transaction((tx) =>
            emitEvent(tx, {
                type: "invoice.issued",
                dedupeKey: "invoice:audience",
                entityType: "invoice",
                entityId: "invoice_audience",
                customerId,
                payload: {
                    number: "RE-AUD",
                    grossCents: 1999,
                    currency: "EUR",
                    dueAt: NOW.toISOString(),
                    reason: "renewal",
                },
            }),
        );

        await dispatchEvents(db, { now: NOW, settings: SETTINGS });

        const mails = await db
            .select()
            .from(schema.emailLog)
            .where(eq(schema.emailLog.dedupeKey, "invoice:invoice_audience"));

        expect(mails).toHaveLength(1);
        expect(mails[0].toEmail).not.toContain("technik");
    });
});
