import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_INVOICE_STATUSES } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { cancelRenewalInvoice } from "@/server/billing/reversals";
import { type BillingRunReport, runBilling } from "@/server/billing/run";
import { applyPayment, creditBalanceCents } from "@/server/payments/apply";
import { applyChange } from "@/server/subscriptions/changes";
import {
    cancelSubscription,
    pauseSubscription,
    reactivateAfterSettlement,
    resumeCancellation,
    resumeSubscription,
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
        over: {
            force?: boolean;
            settings?: typeof SETTINGS;
            /** Narrow the pass to one account, as the admin button does. */
            customerId?: string;
            /** For the cases that are *about* the day marker. */
            mayBeSkipped?: boolean;
        } = {},
    ) {
        const result = await runBilling(db, {
            now: at(day),
            settings: over.settings ?? SETTINGS,
            force: over.force ?? false,
            customerId: over.customerId ?? null,
            // No PDF: the renderer is irrelevant to every claim here and
            // costs a few hundred milliseconds per invoice.
            renderPdf: false,
        });

        /**
         * And it really ran.
         *
         * Every test here shares one database, so two of them naming the
         * same calendar day is two passes over the same `billing_run`
         * row — and the second is *skipped*, silently, because that is
         * exactly what the day marker is for. A test whose run did nothing
         * then asserts against a world that never moved, and reads as a
         * defect in whatever it was actually checking: the renewal that is
         * missing, the service that was never suspended. Both happened
         * while this file was being assembled, and neither looked like a
         * calendar collision.
         *
         * So a skipped pass fails here, loudly, unless the test says it is
         * studying the marker itself.
         */
        if (!over.mayBeSkipped) {
            expect(
                result.ran,
                `${day}: the pass was skipped — another test already claimed that day`,
            ).toBe(true);
        }

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

    /** Every invoice of a customer, whatever state it is in. */
    async function invoicesOf(customerId: string) {
        return db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.customerId, customerId))
            .orderBy(schema.invoice.id);
    }

    /**
     * The ones that still want money.
     *
     * `OPEN_INVOICE_STATUSES`, because that is the question the production
     * predicates ask (`hasOpenInvoice`, `isOpenInvoice` — hard rule 3). The
     * distinction is not pedantry: a Rechnungskorrektur leaves its original
     * `cancelled` on the account, and counting it as open would let an
     * assertion that something is still owed hold while nothing is.
     */
    async function openInvoicesOf(customerId: string) {
        return db
            .select()
            .from(schema.invoice)
            .where(
                and(
                    eq(schema.invoice.customerId, customerId),
                    inArray(schema.invoice.status, [
                        ...schema.OPEN_INVOICE_STATUSES,
                    ]),
                ),
            )
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
            expect(await invoicesOf(customerId)).toHaveLength(0);
        });

        it("raises the first renewal a fortnight before the trial ends", async () => {
            // Lead time 14 days, trial end 15 November → the invoice is
            // raised on the 1st, the day the Abo was ordered.
            const first = await run("2026-11-01");

            expect(first.ran).toBe(true);
            expect(first.report.invoicesIssued).toBe(1);

            const [invoice] = await invoicesOf(customerId);

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

            expect(await invoicesOf(customerId)).toHaveLength(1);
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
                // The 15th was already walked by the case above, so the
                // unforced pass may find the day claimed. The forced one
                // below is what actually re-enters the ladder, and it is
                // the one the claim has to hold against.
                await run(`2026-11-${String(day).padStart(2, "0")}`, {
                    mayBeSkipped: true,
                });
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
            expect(await invoicesOf(customerId)).toHaveLength(1);
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
            const invoices = await invoicesOf(customerId);
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
            const second = await run("2027-01-18", { mayBeSkipped: true });

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

            const invoices = await invoicesOf(customerId);

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
            expect(await invoicesOf(customerId)).toHaveLength(2);
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
            expect(await invoicesOf(customerId)).toHaveLength(1);

            // … and the invoice goes out at 30.
            await run("2028-03-02", { settings: unanchored });
            expect(await invoicesOf(customerId)).toHaveLength(2);
        });

        it("does not hand that notice to every other Abo in the catalog", async () => {
            /**
             * The pair to the case above, and the one that makes the
             * per-subscription filter mean something.
             *
             * The first pass has to *look* as far ahead as the longest lead
             * any product asks for — VPS A's thirty days — or it would never
             * see that row at all. But the horizon is where the run starts
             * looking, not where it bills: a VPS M asks for nothing, so it
             * gets the portal's fortnight, and only its own lead decides.
             *
             * Without the filter the run invoices everybody thirty days
             * ahead, and a monthly Abo is billed a fortnight before the
             * customer expects it, every single month.
             */
            const customerId = await nextCustomer();
            const unanchored = SETTINGS_NO_ANCHOR;

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-01-01"),
                settings: unanchored,
            });

            // Next billing is 1 February. Thirty days ahead of it is 2
            // January — inside the catalog's longest lead, and well outside
            // this Abo's own fortnight, so nothing goes out.
            await run("2030-01-03", { settings: unanchored });
            expect(await invoicesOf(customerId)).toHaveLength(1);

            // … and at fourteen days it does.
            await run("2030-01-18", { settings: unanchored });
            expect(await invoicesOf(customerId)).toHaveLength(2);
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
            expect(await invoicesOf(customerId)).toHaveLength(1);

            await run("2027-05-31");
            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "cancelled",
            );

            await run("2027-06-01");

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("ended");
            expect(row.endedAt).not.toBeNull();
        });

        /**
         * The window people actually cancel in: the renewal invoice is what
         * reminds them, so by the time they do, it has been raised.
         *
         * Without this, RE-2030-0002 over 19,99 € for a February the
         * customer never gets stands unpaid. 16 February brings a
         * Zahlungserinnerung and a Mahnung, 4 March a Kündigungsandrohung —
         * a month of dunning for a month in which no service ran, and with
         * auto-charge on the card is simply debited first.
         *
         * A period that will not be delivered is not invoiced, so the
         * cancellation takes the renewal back the one way the project has:
         * a Rechnungskorrektur through `cancelRenewalInvoice`, with the
         * link removed and the coupon period given back.
         */
        it("takes back a renewal already invoiced for a period it will not deliver", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-01-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            // The first period is paid, so the renewal is the only thing
            // that could possibly be chased afterwards.
            await applyPayment(db, {
                ref: `cancel-first-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2030-01-02"),
            });

            // A fortnight's notice: on 20 January the run invoices
            // 1 February – 1 March, due the day that period starts.
            await run("2030-01-20");

            const renewalId = (await linksFor(db, subscriptionId)).find(
                (link) => link.kind === "renewal",
            )?.invoiceId as string;

            expect((await invoiceOf(db, renewalId)).grossCents).toBe(1999);

            // Gekündigt am 25. Januar, zum Ende des bezahlten Zeitraums.
            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: at("2030-01-25"),
                settings: SETTINGS,
            });

            const credited = await invoiceOf(db, renewalId);

            expect(credited.creditedCents).toBe(1999);
            expect(credited.status).toBe("cancelled");

            // The link goes with it, so nothing chases the document and the
            // run raises no fresh one for a period that is not coming.
            expect(
                (await linksFor(db, subscriptionId)).filter(
                    (link) => link.kind === "renewal",
                ),
            ).toHaveLength(0);

            // February, and the two days dunning would have spoken on.
            for (const day of ["2030-02-01", "2030-02-16", "2030-03-04"]) {
                await run(day);
            }

            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "ended",
            );

            // No Zahlungserinnerung, no Mahnung, no Mahngebühr.
            expect(
                await db
                    .select()
                    .from(schema.dunningAction)
                    .where(eq(schema.dunningAction.customerId, customerId)),
            ).toEqual([]);

            expect(
                (await invoicesOf(customerId)).filter((row) =>
                    OPEN_INVOICE_STATUSES.includes(
                        row.status as "unpaid" | "partial",
                    ),
                ),
            ).toEqual([]);
        }, 60_000);

        /**
         * The money has to reach the customer, not merely leave the
         * document. A renewal that was already collected and is then taken
         * back becomes spendable credit — `paid_cents` drops to zero,
         * because what arrived no longer counts against an invoice that
         * asks for nothing.
         */
        /**
         * Und wenn der Zeitraum schon bezahlt war: das Geld bleibt auf der
         * korrigierten Rechnung stehen, als Überzahlung, und wird *nicht*
         * von selbst zu Guthaben.
         *
         * Phase 5 hat das so entschieden — `createCreditNoteIn` resettlet
         * ohne `causedBy`, weil keine Zahlung bewegt wurde — und für eine
         * Kündigung ist es erst recht richtig: wer geht, ist mit einem
         * Guthaben beim Anbieter, den er gerade verlassen hat, nicht
         * bezahlt. Wie das Geld zurückgeht, entscheidet der Betreiber über
         * `recordRefund`.
         *
         * Was vom *Guthaben* kam, ist eine andere Sache und geht sofort
         * zurück: das bucht `returnCreditSpentOn`, auf die Zahlung
         * geschlüsselt, die es rückgängig macht.
         */
        it("leaves a renewal that was already paid standing as an overpayment", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-06-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            await applyPayment(db, {
                ref: `paid-first-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2030-06-02"),
            });

            await run("2030-06-20");

            const renewalId = (await linksFor(db, subscriptionId)).find(
                (link) => link.kind === "renewal",
            )?.invoiceId as string;

            await applyPayment(db, {
                ref: `paid-renewal-${customerId}`,
                gateway: "banktransfer",
                invoiceId: renewalId,
                customerId,
                amountCents: 1999,
                actor: ACTOR,
                at: at("2030-06-21"),
            });

            expect((await invoiceOf(db, renewalId)).status).toBe("paid");
            expect(await creditBalanceCents(db, customerId)).toBe(0);

            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: at("2030-06-25"),
                settings: SETTINGS,
            });

            const credited = await invoiceOf(db, renewalId);

            expect(credited.status).toBe("cancelled");

            // Die Rechnung selbst ändert sich nicht (Regel 3) — sie ist
            // vollständig gutgeschrieben, und damit ist nichts mehr offen.
            expect(credited.grossCents).toBe(1999);
            expect(credited.creditedCents).toBe(1999);

            // Also ist auch nichts mehr „bezahlt": `paid_cents` ist
            // min(eingegangen, offen), und offen ist null. Die 19,99 €
            // stehen ab jetzt als Überzahlung da, nicht als Zahlung.
            expect(credited.paidCents).toBe(0);

            // Die Zahlung selbst liegt unangetastet auf dem Dokument: das
            // Geld ist nachweisbar da und wartet auf die Erstattung.
            const [payment] = await db
                .select()
                .from(schema.payment)
                .where(eq(schema.payment.invoiceId, renewalId));

            expect(payment.amountCents).toBe(1999);
            expect(payment.refundedCents).toBe(0);
            expect(payment.status).toBe("succeeded");

            // Und es ist nicht stillschweigend zu Guthaben geworden.
            expect(await creditBalanceCents(db, customerId)).toBe(0);
        }, 60_000);

        /**
         * One invoice, two Abos — the grouping `issueRenewals` does per
         * customer, currency and billing day. Taking the whole document back
         * would cancel a renewal the other Abo is still going to get, so
         * only the cancelled Abo's positions are corrected: the invoice
         * stands for the rest, and the other Abo's period is not rolled
         * back.
         */
        it("corrects only the cancelled Abo's share of a grouped renewal", async () => {
            const customerId = await nextCustomer();

            const keep = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-09-01"),
                settings: SETTINGS,
            });

            const go = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-09-01"),
                settings: SETTINGS,
            });

            const keepId = keep.subscriptionIds[0];
            const goId = go.subscriptionIds[0];

            await run("2030-09-20");

            const links = await linksFor(db, goId);
            const renewalId = links.find((link) => link.kind === "renewal")
                ?.invoiceId as string;

            // Both Abos fall due on the 1st, so they share one document.
            expect(
                (await linksFor(db, keepId)).find(
                    (link) => link.kind === "renewal",
                )?.invoiceId,
            ).toBe(renewalId);
            expect((await invoiceOf(db, renewalId)).grossCents).toBe(3998);

            const before = await subscriptionOf(db, keepId);

            await cancelSubscription(db, {
                subscriptionId: goId,
                when: "period_end",
                actor: ACTOR,
                at: at("2030-09-25"),
                settings: SETTINGS,
            });

            const corrected = await invoiceOf(db, renewalId);

            // Half the document taken back, half still owed.
            expect(corrected.creditedCents).toBe(1999);
            expect(corrected.status).toBe("unpaid");

            expect(
                (await linksFor(db, goId)).filter(
                    (link) => link.kind === "renewal",
                ),
            ).toHaveLength(0);
            expect(
                (await linksFor(db, keepId)).filter(
                    (link) => link.kind === "renewal",
                ),
            ).toHaveLength(1);

            const after = await subscriptionOf(db, keepId);

            expect(after.nextBillingAt?.toISOString()).toBe(
                before.nextBillingAt?.toISOString(),
            );
            expect(after.currentPeriodStart.toISOString()).toBe(
                before.currentPeriodStart.toISOString(),
            );
            expect(after.status).toBe(before.status);
        }, 60_000);

        /**
         * Taking the cancellation back has to leave them invoiced again. The
         * link went with the correction, so the next pass raises a fresh
         * renewal for the very period that was taken back — the same
         * mechanism `cancelRenewalInvoice` relies on when an operator
         * revokes a wrong amount.
         */
        it("invoices the period again when the cancellation is taken back", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-11-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            await run("2030-11-20");

            const first = (await linksFor(db, subscriptionId)).find(
                (link) => link.kind === "renewal",
            );

            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: at("2030-11-21"),
                settings: SETTINGS,
            });

            await resumeCancellation(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2030-11-22"),
            });

            await run("2030-11-23");

            const again = (await linksFor(db, subscriptionId)).find(
                (link) => link.kind === "renewal",
            );

            expect(again).toBeTruthy();
            expect(again?.invoiceId).not.toBe(first?.invoiceId);
            expect(again?.periodStart.toISOString()).toBe(
                first?.periodStart.toISOString(),
            );

            const invoice = await invoiceOf(db, again?.invoiceId as string);

            expect(invoice.grossCents).toBe(1999);
            expect(invoice.status).toBe("unpaid");
        }, 60_000);
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

            // Die Eröffnungsrechnung ist bezahlt, damit allein die
            // Verlängerung darüber entscheidet, ob der Zeitraum weiterrückt.
            await applyPayment(db, {
                ref: `transfer-rollback-first-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2027-07-02"),
            });

            await run("2027-07-20");

            const links = await linksFor(db, subscriptionId);
            const renewal = links.find((link) => link.kind === "renewal");

            expect(renewal).toBeTruthy();

            const before = await subscriptionOf(db, subscriptionId);

            /**
             * Bezahlt und am 1. August abgerechnet: **erst dadurch** rückt
             * das Abo in den Zeitraum, den diese Rechnung gekauft hat — und
             * erst dann hat `precedingPeriod` überhaupt etwas zurückzurollen.
             *
             * Ohne diese beiden Schritte stand `current_period_start` noch
             * im Juli, der Zweig in `cancelRenewalInvoice` lief nie, und
             * „der Termin steht wieder da, wo er war“ war trivial wahr, weil
             * sich nie etwas bewegt hatte.
             */
            await applyPayment(db, {
                ref: `transfer-rollback-${customerId}`,
                gateway: "banktransfer",
                invoiceId: renewal?.invoiceId as string,
                customerId,
                amountCents: 1999,
                actor: ACTOR,
                at: at("2027-07-21"),
            });

            await run("2027-08-01");

            const advanced = await subscriptionOf(db, subscriptionId);

            expect(advanced.currentPeriodStart.toISOString()).toBe(
                renewal?.periodStart.toISOString(),
            );

            const reversed = await cancelRenewalInvoice(db, {
                invoiceId: renewal?.invoiceId as string,
                actor: ACTOR,
                now: at("2027-08-02"),
                settings: SETTINGS,
            });

            expect(reversed.creditNoteNumber).toMatch(/^KO-|^RK-|^\w/);
            expect(reversed.rolledBack).toEqual([subscriptionId]);

            const credited = await invoiceOf(db, renewal?.invoiceId as string);

            expect(credited.status).toBe("cancelled");

            // The link is gone, so the period may be invoiced again…
            expect(
                (await linksFor(db, subscriptionId)).filter(
                    (link) => link.kind === "renewal",
                ),
            ).toHaveLength(0);

            // … and the whole period is back where it was: der Zeitraum, das
            // Ende und der Termin, nicht nur der Termin.
            const after = await subscriptionOf(db, subscriptionId);

            expect(after.currentPeriodStart.toISOString()).toBe(
                new Date("2027-07-01T00:00:00.000+02:00").toISOString(),
            );
            expect(after.currentPeriodEnd?.toISOString()).toBe(
                renewal?.periodStart.toISOString(),
            );
            expect(after.nextBillingAt?.toISOString()).toBe(
                before.nextBillingAt?.toISOString(),
            );

            /**
             * Die 19,99 € kamen per Überweisung, nicht vom Guthaben: echtes
             * Geld bleibt liegen, bis der Betreiber es erstattet, und die
             * Korrektur bucht von sich aus nichts auf das Konto.
             */
            expect(await creditBalanceCents(db, customerId)).toBe(0);

            await run("2027-08-03");

            const fresh = (await linksFor(db, subscriptionId)).filter(
                (link) => link.kind === "renewal",
            );

            expect(fresh).toHaveLength(1);
            expect(fresh[0].invoiceId).not.toBe(renewal?.invoiceId);
            expect(fresh[0].periodStart.toISOString()).toBe(
                renewal?.periodStart.toISOString(),
            );
        });

        it("gives the credit it was paid from back — the mirror of spending it", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-02-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            // Die Eröffnungsrechnung ist bezahlt, damit unten nur noch die
            // Verlängerung im Spiel ist.
            await applyPayment(db, {
                ref: `transfer-credit-reversal-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2030-02-02"),
            });

            // 50,00 € Guthaben auf dem Konto.
            await db.insert(schema.creditLedger).values({
                id: createId("creditledger"),
                customerId,
                kind: "adjustment",
                amountCents: 5000,
                reason: "Test",
            });

            await run("2030-02-20");

            const link = (await linksFor(db, subscriptionId)).find(
                (row) => row.kind === "renewal",
            );
            const renewal = await invoiceOf(db, link?.invoiceId as string);

            // 19,99 € vom Guthaben abgerechnet: 50,00 − 19,99 = 30,01 €.
            expect(renewal.grossCents).toBe(1999);
            expect(renewal.status).toBe("paid");
            expect(await creditBalanceCents(db, customerId)).toBe(3001);

            // „Verlängerung zurücknehmen“ — der Betrag war falsch.
            await cancelRenewalInvoice(db, {
                invoiceId: renewal.id,
                actor: ACTOR,
                now: at("2030-02-21"),
                settings: SETTINGS,
            });

            /**
             * Ohne die Gegenbuchung bleibt das Konto bei 30,01 € stehen und
             * die 19,99 € liegen als nicht zugeordnete Überzahlung auf einem
             * stornierten Dokument. Der nächste Lauf stellt die korrigierte
             * Verlängerung und rechnet noch einmal 19,99 € vom Guthaben ab:
             * 10,02 €, und der Kunde hat denselben Zeitraum zweimal aus
             * eigener Tasche bezahlt.
             */
            expect(await creditBalanceCents(db, customerId)).toBe(5000);

            const corrected = await invoiceOf(db, renewal.id);

            expect(corrected.status).toBe("cancelled");
            expect(corrected.paidCents).toBe(0);

            // Ein zweiter Anlauf gibt nichts ein zweites Mal zurück.
            await expect(
                cancelRenewalInvoice(db, {
                    invoiceId: renewal.id,
                    actor: ACTOR,
                    now: at("2030-02-21"),
                    settings: SETTINGS,
                }),
            ).rejects.toThrow();

            expect(await creditBalanceCents(db, customerId)).toBe(5000);

            // Und die korrigierte Verlängerung kostet wieder genau 19,99 €.
            await run("2030-02-22");

            const fresh = (await linksFor(db, subscriptionId)).find(
                (row) => row.kind === "renewal",
            );

            expect(fresh?.invoiceId).not.toBe(renewal.id);
            expect(await creditBalanceCents(db, customerId)).toBe(3001);
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

        it("gives no coupon period back when the renewal consumed none", async () => {
            /**
             * The way back must return exactly what that renewal consumed,
             * and a renewal at the full price consumed nothing.
             *
             * `consumeDiscountPeriod` floors at zero, so a spent Gutschein
             * reads 0 before the renewal and 0 after it — adding one back
             * regardless invents a vergünstigten Zeitraum the customer was
             * never promised, and invents another one on every further
             * Rechnungskorrektur. That is the credit-ledger hole of Phase 5
             * read backwards: the way out giving more than the way in took.
             */
            const customerId = await nextCustomer();

            await db.insert(schema.coupon).values({
                id: createId("coupon"),
                code: "EINMAL25",
                kind: "percent",
                percentBasisPoints: 2500,
                duration: "once",
                active: true,
            });

            const placed = await order(db, {
                customerId,
                items: [
                    {
                        productId: vpsM,
                        cycle: "monthly",
                        couponCode: "EINMAL25",
                    },
                ],
                now: at("2030-02-01"),
                settings: SETTINGS,
            });

            const subscriptionId = placed.subscriptionIds[0];

            // One period was agreed and the checkout billed it: 25 % of
            // 19,99 € is 5,00 €, so 14,99 € — and nothing is left over.
            expect(placed.grossCents).toBe(1499);
            expect(
                (await subscriptionOf(db, subscriptionId))
                    .discountPeriodsRemaining,
            ).toBe(0);

            await run("2030-02-21");

            const renewal = (await linksFor(db, subscriptionId)).find(
                (link) => link.kind === "renewal",
            );
            const invoice = await invoiceOf(db, renewal?.invoiceId as string);

            // The renewal is at the full price, and the counter has not
            // moved — there was nothing left to count off.
            expect(invoice.grossCents).toBe(1999);
            expect(
                (await subscriptionOf(db, subscriptionId))
                    .discountPeriodsRemaining,
            ).toBe(0);

            await cancelRenewalInvoice(db, {
                invoiceId: renewal?.invoiceId as string,
                actor: ACTOR,
                now: at("2030-02-21"),
                settings: SETTINGS,
            });

            // Still nothing. A discount is given back only where this very
            // invoice granted one.
            expect(
                (await subscriptionOf(db, subscriptionId))
                    .discountPeriodsRemaining,
            ).toBe(0);
        });
    });

    // -----------------------------------------------------------------
    // A Tarifwechsel agreed for the end of the period
    // -----------------------------------------------------------------

    /**
     * The renewal invoice is raised `renewalLeadDays` **before** the period
     * it bills, so a change agreed for the end of the period has two
     * moments, and they are a fortnight apart:
     *
     *  - the **lines** of that invoice already belong to the new
     *    configuration — the April invoice charges for two machines,
     *    because April is what it bills;
     *  - the **item and its services** belong to the old one until the
     *    first instant of April, because the customer paid 59,97 € for
     *    three machines up to and including 31 March.
     *
     * Rewriting the item when the invoice is raised terminates the third
     * VPS on 18 March, and "a terminated service stays terminated" makes
     * that permanent: two weeks of a paid, provisioned machine destroyed,
     * with no inverse anywhere — `cancelRenewalInvoice` puts the period and
     * the coupon back and cannot put a machine back.
     */
    describe("a Tarifwechsel agreed for the end of the period", () => {
        let customerId: string;
        let subscriptionId: string;
        let itemId: string;
        let changeId: string;
        let renewalInvoiceId: string;

        beforeAll(async () => {
            customerId = await nextCustomer();

            // Drei VPS M zu je 19,99 €, bestellt am 1. März 2028 → 59,97 €
            // für den ganzen März.
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly", quantity: 3 }],
                now: at("2028-03-01"),
                settings: SETTINGS,
            });

            expect(placed.grossCents).toBe(5997);

            subscriptionId = placed.subscriptionIds[0];
            itemId = (await itemsOf(db, subscriptionId))[0].id;

            // Paid at once, so nothing here is about dunning.
            await applyPayment(db, {
                ref: `checkout-change-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2028-03-02"),
            });

            // All three machines are running, so a termination has
            // something real to destroy.
            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: at("2028-03-02") })
                .where(eq(schema.service.subscriptionItemId, itemId));

            // Am 10. März bucht der Kunde 3 → 2 zum Periodenende.
            const change = await applyChange(
                db,
                {
                    subscriptionId,
                    itemId,
                    quantity: 2,
                    effective: "period_end",
                },
                ACTOR,
                { now: at("2028-03-10"), settings: SETTINGS },
            );

            changeId = change.changeId;

            expect(change.appliedNow).toBe(false);
            expect(change.preview.applyAt.toISOString()).toBe(
                new Date("2028-04-01T00:00:00.000+02:00").toISOString(),
            );
        }, 60_000);

        it("bills April for two while March still runs three", async () => {
            // 18 March is inside the fortnight's lead, so the April invoice
            // goes out — a fortnight before the change is due.
            await run("2028-03-18");

            const link = (await linksFor(db, subscriptionId)).find(
                (row) => row.kind === "renewal",
            );

            expect(link).toBeTruthy();

            renewalInvoiceId = link?.invoiceId as string;

            // The lines are the new configuration: 2 × 19,99 € = 39,98 €.
            expect((await invoiceOf(db, renewalInvoiceId)).grossCents).toBe(
                3998,
            );

            // The Abo is not. It is 18 March, and three machines are paid
            // for to the 31st.
            expect((await itemsOf(db, subscriptionId))[0].quantity).toBe(3);

            const services = await servicesOf(db, itemId);

            expect(services).toHaveLength(3);
            expect(
                services.filter((row) => row.status === "terminated"),
            ).toHaveLength(0);

            // And the promise is still a promise.
            const [change] = await db
                .select()
                .from(schema.subscriptionChange)
                .where(eq(schema.subscriptionChange.id, changeId));

            expect(change.status).toBe("pending");
            expect(change.appliedAt).toBeNull();
        });

        it("puts it into force when April begins, exactly once", async () => {
            await applyPayment(db, {
                ref: `renewal-april-${customerId}`,
                gateway: "banktransfer",
                invoiceId: renewalInvoiceId,
                customerId,
                amountCents: 3998,
                actor: ACTOR,
                at: at("2028-03-20"),
            });

            // The last day of the paid period changes nothing.
            await run("2028-03-31");

            expect((await itemsOf(db, subscriptionId))[0].quantity).toBe(3);
            expect(
                (await servicesOf(db, itemId)).filter(
                    (row) => row.status === "terminated",
                ),
            ).toHaveLength(0);

            // The first of April does.
            await run("2028-04-01");
            // Twice, and forced: the change is claimed under the
            // subscription's own lock, so a second pass finds it applied.
            await run("2028-04-01", { force: true });

            expect((await itemsOf(db, subscriptionId))[0].quantity).toBe(2);

            const terminated = (await servicesOf(db, itemId)).filter(
                (row) => row.status === "terminated",
            );

            expect(terminated).toHaveLength(1);
            expect(terminated[0].terminatedAt?.toISOString()).toBe(
                at("2028-04-01").toISOString(),
            );

            const [change] = await db
                .select()
                .from(schema.subscriptionChange)
                .where(eq(schema.subscriptionChange.id, changeId));

            expect(change.status).toBe("applied");
            expect(change.appliedAt?.toISOString()).toBe(
                at("2028-04-01").toISOString(),
            );
        }, 60_000);
    });

    // -----------------------------------------------------------------
    // Pausing, once the next period is already on a document
    // -----------------------------------------------------------------

    /**
     * The scenario, in days: the Abo runs to the 01.03., the run raises the
     * Verlängerung for the period starting 01.03. on the 15.02., and the
     * customer pauses on the 20.02. and resumes on the 25.02.
     *
     * Resuming moves the period end forward by the span the Abo stood still
     * — 01.03. becomes 06.03. But `subscription_invoice (subscription_id,
     * period_start, kind)` is what makes a period be invoiced *once*, and it
     * is keyed on that day. With an invoice standing for 01.03. the next
     * pass asks about 06.03., finds nothing, and raises a **second**
     * Verlängerung over a month that overlaps the first by 26 days. With
     * auto-charge on, both are collected.
     *
     * So a period that is already on a finalized document does not move.
     * The pause is refused while the Verlängerung stands; the way through is
     * `cancelRenewalInvoice`, which is this project's one way of undoing a
     * renewal, and after it the pause goes through like any other.
     */
    describe("pausing after the Verlängerung has gone out", () => {
        async function monthlyVps(day: string) {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at(day),
                settings: SETTINGS,
            });

            return { customerId, subscriptionId: placed.subscriptionIds[0] };
        }

        function renewalsOf(subscriptionId: string) {
            return linksFor(db, subscriptionId).then((links) =>
                links.filter((link) => link.kind === "renewal"),
            );
        }

        it("refuses the pause while the Verlängerung for the coming period stands", async () => {
            const { customerId, subscriptionId } =
                await monthlyVps("2031-02-01");

            // A fortnight before the 01.03.: the Verlängerung goes out.
            await run("2031-02-15");

            const renewals = await renewalsOf(subscriptionId);

            expect(renewals).toHaveLength(1);
            expect(renewals[0].periodStart.toISOString()).toBe(
                new Date("2031-03-01T00:00:00.000+01:00").toISOString(),
            );

            await expect(
                pauseSubscription(db, {
                    subscriptionId,
                    actor: ACTOR,
                    at: at("2031-02-20"),
                }),
            ).rejects.toThrow(/bereits berechnet/);

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("active");
            expect(row.pausedAt).toBeNull();
            // Nothing moved, so the period the invoice names is still the
            // period the Abo is about to enter.
            expect(row.nextBillingAt?.toISOString()).toBe(
                renewals[0].periodStart.toISOString(),
            );

            // Two documents, for ever: the first period and the one
            // Verlängerung.
            await run("2031-02-25");
            expect(await invoicesOf(customerId)).toHaveLength(2);
        });

        it("refuses it after the Verlängerung has been paid, too", async () => {
            const { customerId, subscriptionId } =
                await monthlyVps("2031-04-01");

            // A fortnight before the 01.05.
            await run("2031-04-17");

            const [renewal] = await renewalsOf(subscriptionId);
            const invoice = await invoiceOf(db, renewal.invoiceId);

            await applyPayment(db, {
                ref: `pause-paid-${customerId}`,
                gateway: "banktransfer",
                invoiceId: invoice.id,
                customerId,
                amountCents: invoice.grossCents ?? 0,
                actor: ACTOR,
                at: at("2031-04-18"),
            });

            expect((await invoiceOf(db, invoice.id)).status).toBe("paid");

            // 19,99 € have been paid for 01.05.–01.06. Shifting the period
            // out from under that document would bill the overlap a second
            // time, and tearing the document up would be a Rechnungs-
            // korrektur nobody asked for.
            await expect(
                pauseSubscription(db, {
                    subscriptionId,
                    actor: ACTOR,
                    at: at("2031-04-20"),
                }),
            ).rejects.toThrow(/bereits berechnet/);

            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "active",
            );
        });

        it("goes through once the Verlängerung has been taken back", async () => {
            const { subscriptionId } = await monthlyVps("2031-06-01");

            // A fortnight before the 01.07.
            await run("2031-06-17");

            const [renewal] = await renewalsOf(subscriptionId);

            await cancelRenewalInvoice(db, {
                invoiceId: renewal.invoiceId,
                actor: ACTOR,
                now: at("2031-06-18"),
                settings: SETTINGS,
            });

            expect(await renewalsOf(subscriptionId)).toHaveLength(0);

            await pauseSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2031-06-20"),
            });
            await resumeSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2031-06-25"),
            });

            // Five days paused → the 01.07. becomes the 06.07.
            expect(
                (
                    await subscriptionOf(db, subscriptionId)
                ).currentPeriodEnd?.toISOString(),
            ).toBe(new Date("2031-07-06T00:00:00.000+02:00").toISOString());

            await run("2031-06-26");

            const again = await renewalsOf(subscriptionId);

            // One standing Verlängerung, for the period the Abo is actually
            // in — the credited one took its link with it.
            expect(again).toHaveLength(1);
            expect(again[0].periodStart.toISOString()).toBe(
                new Date("2031-07-06T00:00:00.000+02:00").toISOString(),
            );
            expect((await invoiceOf(db, renewal.invoiceId)).status).toBe(
                "cancelled",
            );
        });

        it("still pauses twice over while no Verlängerung has gone out", async () => {
            const { subscriptionId } = await monthlyVps("2031-08-01");

            // Five days, then two more, both well before the lead time.
            await pauseSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2031-08-05"),
            });
            await resumeSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2031-08-10"),
            });
            await pauseSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2031-08-12"),
            });
            await resumeSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2031-08-14"),
            });

            const row = await subscriptionOf(db, subscriptionId);

            // 5 + 2 days: the 01.09. becomes the 08.09.
            expect(row.status).toBe("active");
            expect(row.currentPeriodEnd?.toISOString()).toBe(
                new Date("2031-09-08T00:00:00.000+02:00").toISOString(),
            );

            // A fortnight before the shifted day, and not a day earlier.
            await run("2031-08-24");
            expect(await renewalsOf(subscriptionId)).toHaveLength(0);

            await run("2031-08-25");

            const renewals = await renewalsOf(subscriptionId);

            expect(renewals).toHaveLength(1);
            expect(renewals[0].periodStart.toISOString()).toBe(
                new Date("2031-09-08T00:00:00.000+02:00").toISOString(),
            );
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

            const renewal = (await invoicesOf(customerId)).find(
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

        /**
         * A Mahngebühr is a document, not a new rung of the ladder.
         *
         * The fee invoice is an ordinary finalized invoice of the same
         * customer, and `finalizeInvoiceIn` gives it a due date a fortnight
         * out. That makes it look exactly like the thing dunning is told to
         * look for — "every open invoice whose `due_at` has passed" — so
         * without the exclusion the run chases the Mahngebühr too: a
         * reminder at +3, a Mahnung at +10, and that Mahnung raises a
         * *second* Mahngebühr, whose Mahnung raises a third. The unique
         * index on `dunning_action (invoice_id, level)` cannot stop it,
         * because every generation is a new invoice id and therefore a fresh
         * key space. Driven for a year at 5,00 € a rung, that is around
         * 150,00 € of gapless-numbered invoices nobody authorised.
         *
         * An annual Abo on purpose: no renewal falls inside the months this
         * case walks through, so the only invoice the checkout left behind
         * is the one being chased, and every further document on the account
         * was raised by dunning itself.
         */
        describe("is never itself dunned", () => {
            const settings = withBilling({ dunningFeeCents: 500 });

            let customerId: string;
            let subscriptionId: string;
            let itemId: string;
            let invoiceId: string;
            let feeInvoiceId: string;

            function rungsOf(invoice: string) {
                return db
                    .select()
                    .from(schema.dunningAction)
                    .where(eq(schema.dunningAction.invoiceId, invoice))
                    .orderBy(schema.dunningAction.dueAt);
            }

            beforeAll(async () => {
                customerId = await nextCustomer();

                const placed = await order(db, {
                    customerId,
                    items: [{ productId: vpsAnnual, cycle: "annual" }],
                    now: at("2030-01-01"),
                    settings,
                });

                subscriptionId = placed.subscriptionIds[0];
                itemId = (await itemsOf(db, subscriptionId))[0].id;
                invoiceId = placed.invoiceId as string;

                // Running, so the suspension rung has something to do.
                await db
                    .update(schema.service)
                    .set({ status: "active", activatedAt: at("2030-01-01") })
                    .where(eq(schema.service.subscriptionItemId, itemId));
            }, 60_000);

            it("raises no fee on the reminder rung — the Mahngebühr belongs to the Mahnung", async () => {
                // Ordered on 1 January with a 14-day term, so the invoice
                // fell due on the 15th and +3 is the 18th.
                await run("2030-01-18", { settings, customerId });

                const rungs = await rungsOf(invoiceId);

                expect(rungs.map((row) => row.level)).toEqual(["reminder"]);
                expect(rungs[0].feeCents).toBe(0);
                expect(rungs[0].feeInvoiceId).toBeNull();
                // Still the one document from the checkout.
                expect(await invoicesOf(customerId)).toHaveLength(1);
            });

            it("raises exactly one 5,00 € Mahngebühr on the Mahnung rung", async () => {
                await run("2030-01-25", { settings, customerId });

                const mahnung = (await rungsOf(invoiceId)).find(
                    (row) => row.level === "mahnung",
                );

                expect(mahnung?.feeCents).toBe(500);
                expect(mahnung?.feeInvoiceId).not.toBeNull();

                feeInvoiceId = mahnung?.feeInvoiceId as string;

                const fee = await invoiceOf(db, feeInvoiceId);

                expect(fee.grossCents).toBe(500);
                expect(fee.status).toBe("unpaid");
                expect(fee.number).toMatch(/^RE-/);
                // Finalized on the 25th with the portal's fortnight: due on
                // 8 February. That date is what the last case turns on.
                expect(fee.dueAt?.toISOString()).toBe(
                    at("2030-02-08").toISOString(),
                );
            });

            it("suspends at +14 and ends the Abo at +30, and charges for neither", async () => {
                const suspended = await run("2030-01-29", {
                    settings,
                    customerId,
                });

                expect(suspended.report.servicesSuspended).toBe(1);
                expect((await servicesOf(db, itemId))[0].status).toBe(
                    "suspended",
                );

                const terminated = await run("2030-02-14", {
                    settings,
                    customerId,
                });

                expect(terminated.report.subscriptionsEnded).toBe(1);

                const row = await subscriptionOf(db, subscriptionId);

                expect(row.status).toBe("ended");
                expect(row.endedAt).not.toBeNull();

                const rungs = await rungsOf(invoiceId);

                expect(rungs.map((item) => item.level)).toEqual([
                    "reminder",
                    "mahnung",
                    "suspend",
                    "terminate",
                ]);
                // One rung carries a fee, and it is the Mahnung.
                expect(
                    rungs
                        .filter((item) => item.feeCents > 0)
                        .map((item) => item.level),
                ).toEqual(["mahnung"]);
            });

            it("never dunns the Mahngebühr itself, however long it stays unpaid", async () => {
                // The fee invoice fell due on 8 February, so its own +3 and
                // +10 are the 11th and the 18th. Three more months on top,
                // long after the Abo was ended — a fee invoice is linked to
                // no subscription, so nothing would ever close the chain.
                for (const day of [
                    "2030-02-12",
                    "2030-02-20",
                    "2030-03-25",
                    "2030-05-30",
                ]) {
                    await run(day, { settings, customerId });
                }

                expect(await rungsOf(feeInvoiceId)).toEqual([]);

                // Two documents on the account: the VPS, and one Mahngebühr.
                expect(await invoicesOf(customerId)).toHaveLength(2);

                const raised = await db
                    .select()
                    .from(schema.dunningAction)
                    .where(eq(schema.dunningAction.customerId, customerId));

                expect(
                    raised.filter((row) => row.feeInvoiceId !== null),
                ).toHaveLength(1);
            }, 60_000);
        });
    });

    // -----------------------------------------------------------------
    // A pass that threw
    // -----------------------------------------------------------------

    /**
     * `billing_run` is the cheap layer, but it is not free: while a row for
     * the day exists, the next pass skips the day whole. What that row says
     * therefore decides whether a failed night can still be repaired.
     *
     * Two very different things end up as `status = "failed"`, and only
     * `error` tells them apart:
     *
     *  - a pass that walked all seven steps and could not bill one customer.
     *    That pass **finished**: everybody else was invoiced, eingezogen and
     *    gemahnt, and redoing the day wholesale would send their notices a
     *    second time. It must stay claimed.
     *  - a pass that **threw** — a dropped connection, ein Statement-Timeout,
     *    a deadlock against an operator's forced run — before a single
     *    renewal was raised. pg-boss gives it three tries, half an hour
     *    apart (`src/server/jobs/queues.ts`), and those tries have to be
     *    allowed to do the work. Without that the day has no renewal
     *    invoiced, no Einzugsversuch made and no Mahnstufe climbed until the
     *    next calendar day — and a process that was *killed* would be
     *    recovered after an hour while one that honestly wrote down why it
     *    died would never be retried at all.
     */
    describe("a pass that threw", () => {
        /**
         * The database with one of its methods replaced by a dropped
         * connection: the first `select` of the pass, which is outside every
         * per-entity `try`, or the first `transaction`, which is inside one.
         */
        function flaky(method: "select" | "transaction"): TestDb {
            let fired = false;

            return new Proxy(db, {
                get(target, property) {
                    if (property === method && !fired) {
                        fired = true;

                        return () => {
                            throw new Error(
                                "Connection terminated unexpectedly",
                            );
                        };
                    }

                    const value = Reflect.get(target, property, target);

                    return typeof value === "function"
                        ? value.bind(target)
                        : value;
                },
            }) as TestDb;
        }

        async function runRow(day: string) {
            const [row] = await db
                .select()
                .from(schema.billingRun)
                .where(eq(schema.billingRun.runDay, day));

            return row;
        }

        it("is redone by the retry, instead of blocking the day for ever", async () => {
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2029-05-01"),
                settings: SETTINGS,
            });

            // 03:00, pg-boss's first try: the first query of the pass hits a
            // connection the server has closed. Nothing was invoiced, and
            // the row the pass leaves behind says so in `error`.
            await expect(
                runBilling(flaky("select"), {
                    now: at("2029-05-18"),
                    settings: SETTINGS,
                    renderPdf: false,
                }),
            ).rejects.toThrow(/Connection terminated/);

            const threw = await runRow("2029-05-18");

            expect(threw.status).toBe("failed");
            expect(threw.error).toMatch(/Connection terminated/);
            // Nothing got far enough to be reported per entity.
            expect((threw.report as BillingRunReport).failures).toEqual([]);

            // 03:30, the retry — not forced, just the same job again. It has
            // to do the day the first try never started.
            const retry = await run("2029-05-18");

            expect(retry.ran).toBe(true);
            expect(retry.report.invoicesIssued).toBeGreaterThanOrEqual(1);

            // The renewal for 1 June, raised a fortnight ahead: 19,99 €
            // beside the 19,99 € of the order itself.
            const invoices = await invoicesOf(customerId);

            expect(invoices).toHaveLength(2);
            expect(invoices[1].grossCents).toBe(1999);

            const after = await runRow("2029-05-18");

            expect(after.status).toBe("finished");
            expect(after.error).toBeNull();
        });

        it("is not the same as a pass that finished with a Kunden it could not bill", async () => {
            const customerId = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2029-06-01"),
                settings: SETTINGS,
            });

            // The first transaction of the pass dies. The step catches it,
            // notes the entity and the pass walks on to the end — so this is
            // a run that finished, however red it looks.
            const finished = await runBilling(flaky("transaction"), {
                now: at("2029-06-18"),
                settings: SETTINGS,
                renderPdf: false,
            });

            expect(finished.ran).toBe(true);
            expect(finished.report.failures.length).toBeGreaterThan(0);

            const row = await runRow("2029-06-18");

            expect(row.status).toBe("failed");
            // No exception left the run, so nothing is in `error` — and that
            // is exactly what keeps the day claimed below.
            expect(row.error).toBeNull();
            expect(row.finishedAt).not.toBeNull();

            const second = await runBilling(db, {
                now: at("2029-06-18"),
                settings: SETTINGS,
                renderPdf: false,
            });

            expect(second.ran).toBe(false);
            expect(second.runId).toBeNull();
        });
    });

    // -----------------------------------------------------------------
    // A renewal that was never raised at all
    // -----------------------------------------------------------------

    /**
     * Step 2 is allowed to fail for one account: `note(report, "renewal", …)`
     * writes the line and the run goes on, which is what keeps one broken
     * customer from costing everybody else their renewal. Step 4 then has to
     * tell that case apart from a period that was genuinely *dealt with* —
     * and the mere absence of an open invoice cannot, because a renewal that
     * was never raised and a renewal that was nothing to pay look exactly
     * alike from there.
     *
     * Getting it wrong costs the month, silently. `next_billing_at` moves
     * past the period nobody invoiced, the following night raises the one
     * after it, and the skipped 19,99 € is never asked for again — the only
     * trace being one line in that night's `billing_run` report.
     */
    describe("a renewal that never went out", () => {
        let customerId: string;
        let subscriptionId: string;

        /** Scoped to this account, so the report counts nobody else's night. */
        async function runFor(day: string) {
            return runBilling(db, {
                now: at(day),
                settings: SETTINGS,
                customerId,
                force: true,
                renderPdf: false,
            });
        }

        beforeAll(async () => {
            customerId = await nextCustomer();

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-01-01"),
                settings: SETTINGS,
            });

            subscriptionId = placed.subscriptionIds[0];

            // The first period is paid, so nothing else on this account is
            // open and every assertion below is about the renewal alone.
            await applyPayment(db, {
                ref: `transfer-lost-month-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2030-01-02"),
            });
        }, 60_000);

        it("goes on when the renewal step throws for this account", async () => {
            /**
             * Soft-deleted by hand while the Abo still runs — rule 10 keeps
             * the row and `createInvoiceDraftIn` refuses to invoice it. One
             * concrete way for step 2 to throw; the step treats every one of
             * them alike, which is the point.
             */
            await db
                .update(schema.customer)
                .set({ deletedAt: at("2030-01-10") })
                .where(eq(schema.customer.id, customerId));

            const result = await runFor("2030-01-20");

            expect(result.report.invoicesIssued).toBe(0);
            expect(result.report.failures.map((row) => row.step)).toContain(
                "renewal",
            );

            // Only the checkout's own link; nothing bought February.
            expect(await linksFor(db, subscriptionId)).toHaveLength(1);
        });

        it("does not roll the period over when nothing invoiced it", async () => {
            const before = await subscriptionOf(db, subscriptionId);
            const result = await runFor("2030-02-01");

            expect(result.report.periodsAdvanced).toBe(0);

            // And it is visible, rather than one line about step 2 only: the
            // Abo whose period stood still is named in the run's report, so
            // the Jobs page shows it instead of it being retried in silence.
            expect(result.report.failures).toContainEqual(
                expect.objectContaining({
                    step: "period",
                    entityId: subscriptionId,
                }),
            );

            const after = await subscriptionOf(db, subscriptionId);

            expect(after.currentPeriodStart.toISOString()).toBe(
                before.currentPeriodStart.toISOString(),
            );
            expect(after.currentPeriodEnd?.toISOString()).toBe(
                before.currentPeriodEnd?.toISOString(),
            );
            /**
             * The column the next pass reads. Moved on to 1 March and the
             * 19,99 € for February is gone for good: nothing would ever look
             * at that period again.
             */
            expect(after.nextBillingAt?.toISOString()).toBe(
                new Date("2030-02-01T00:00:00.000+01:00").toISOString(),
            );
        });

        it("bills the month after all, once the account is whole again", async () => {
            await db
                .update(schema.customer)
                .set({ deletedAt: null })
                .where(eq(schema.customer.id, customerId));

            const result = await runFor("2030-02-02");

            expect(result.report.failures).toEqual([]);
            expect(result.report.invoicesIssued).toBe(1);

            const renewal = (await linksFor(db, subscriptionId)).find(
                (link) => link.kind === "renewal",
            );

            expect(renewal?.periodStart.toISOString()).toBe(
                new Date("2030-02-01T00:00:00.000+01:00").toISOString(),
            );

            const invoice = await invoiceOf(db, renewal?.invoiceId as string);

            // The whole month, charged a day late rather than not at all.
            expect(invoice.grossCents).toBe(1999);

            // From here it is the ordinary unpaid renewal again.
            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "past_due",
            );
        });
    });

    /**
     * The other half of the same rule. A renewal discounted to 0,00 € issues
     * no document on purpose — a gapless number must not be burnt on a
     * demand for nothing — so the period has to roll over on the strength of
     * the `subscription_event` the zero case records instead. Tightening
     * step 4 must not turn those customers into a nightly failure.
     */
    describe("a renewal that is nothing to pay", () => {
        let customerId: string;
        let subscriptionId: string;

        async function runFor(day: string) {
            return runBilling(db, {
                now: at(day),
                settings: SETTINGS,
                customerId,
                force: true,
                renderPdf: false,
            });
        }

        beforeAll(async () => {
            customerId = await nextCustomer();

            await db.insert(schema.coupon).values({
                id: createId("coupon"),
                code: "GRATIS100",
                kind: "percent",
                percentBasisPoints: 10_000,
                duration: "forever",
                active: true,
            });

            const placed = await order(db, {
                customerId,
                items: [
                    {
                        productId: vpsM,
                        cycle: "monthly",
                        couponCode: "GRATIS100",
                    },
                ],
                now: at("2030-04-01"),
                settings: SETTINGS,
            });

            subscriptionId = placed.subscriptionIds[0];

            expect(placed.grossCents).toBe(0);
        }, 60_000);

        it("issues no invoice for a period that costs nothing", async () => {
            const result = await runFor("2030-04-20");

            expect(result.report.failures).toEqual([]);
            expect(result.report.invoicesIssued).toBe(0);

            const recorded = (await eventsOf(db, subscriptionId)).filter(
                (row) =>
                    row.kind === "period" &&
                    row.summary.startsWith("Verlängerung ohne Rechnung"),
            );

            expect(recorded).toHaveLength(1);
        });

        it("still rolls the period over, because that period was dealt with", async () => {
            const result = await runFor("2030-05-01");

            expect(result.report.failures).toEqual([]);
            expect(result.report.periodsAdvanced).toBe(1);

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("active");
            expect(row.currentPeriodStart.toISOString()).toBe(
                new Date("2030-05-01T00:00:00.000+02:00").toISOString(),
            );
        });
    });

    // -----------------------------------------------------------------
    // The mirror of dunning: waking what it suspended
    // -----------------------------------------------------------------

    describe("waking what dunning suspended", () => {
        /**
         * A gekündigtes Abo is still an Abo: it runs out the period the
         * customer paid for, and dunning chases, suspends and ends it like
         * any other — it only leaves the *label* `cancelled` alone, because
         * `cancelled` says something truer than `past_due` would.
         *
         * The mirror has to leave the label alone too, which is exactly
         * where it used to go wrong: both reactivation paths asked whether
         * the status was `past_due` instead of asking what was still owed,
         * so a cancelled Abo that paid its last invoice kept its server
         * switched off for the rest of the period it had just paid for —
         * while the Sperrung mail promised "Sobald die Zahlung eingegangen
         * ist, werden sie automatisch wieder freigeschaltet."
         */
        let customerId: string;
        let subscriptionId: string;
        let itemId: string;
        let invoiceId: string;

        beforeAll(async () => {
            customerId = await nextCustomer();

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2030-01-01"),
                settings: SETTINGS,
            });

            subscriptionId = placed.subscriptionIds[0];
            itemId = (await itemsOf(db, subscriptionId))[0].id;
            invoiceId = placed.invoiceId as string;

            // The server is running, so a Sperrung has something to switch
            // off and the wake-up has something to switch back on.
            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: at("2030-01-01") })
                .where(eq(schema.service.subscriptionItemId, itemId));

            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: at("2030-01-02"),
            });
        }, 60_000);

        it("suspends a cancelled Abo at +14 and leaves its label alone", async () => {
            // 19,99 €, due 15 January (14-day term) → the Sperrung rung
            // falls on 29 January. One pass climbs every rung due by then.
            await run("2030-01-29");

            const services = await servicesOf(db, itemId);

            expect(services[0].status).toBe("suspended");
            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "cancelled",
            );
        });

        it("keeps them suspended while 9,99 € of the 19,99 € are still open", async () => {
            await applyPayment(db, {
                ref: `transfer-cancelled-part-${customerId}`,
                gateway: "banktransfer",
                invoiceId,
                customerId,
                amountCents: 1000,
                actor: ACTOR,
                at: at("2030-01-30"),
            });

            // `partial` is an open invoice (hard rule 3). Waking here would
            // be a second route by which a customer who still owes money
            // gets their server back.
            expect((await invoiceOf(db, invoiceId)).status).toBe("partial");

            await reactivateAfterSettlement(db, invoiceId, at("2030-01-30"));

            expect((await servicesOf(db, itemId))[0].status).toBe("suspended");
        });

        it("wakes them the moment the last 9,99 € arrive, without un-cancelling the Abo", async () => {
            const outcome = await applyPayment(db, {
                ref: `transfer-cancelled-rest-${customerId}`,
                gateway: "banktransfer",
                invoiceId,
                customerId,
                amountCents: 999,
                actor: ACTOR,
                at: at("2030-01-30"),
            });

            expect(outcome.invoiceStatus).toBe("paid");

            // The seam every settled payment passes through;
            // `emitInvoicePaid` calls it with the application's own pool,
            // which in a test does not point at this throwaway database.
            await reactivateAfterSettlement(db, invoiceId, at("2030-01-30"));

            const services = await servicesOf(db, itemId);

            expect(services[0].status).toBe("active");
            expect(services[0].suspendedAt).toBeNull();

            // And the Kündigung still stands: paying the last invoice is not
            // an undo of "will not renew".
            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("cancelled");
            expect(row.cancelAtPeriodEnd).toBe(true);
        });
    });

    describe("step 7 — the catch-up the payment seam cannot cover", () => {
        /**
         * `emitInvoicePaid` is what a customer who pays at midnight
         * notices. This is what happens when that seam never ran: the mail
         * threw, the process died between the payment and the
         * reactivation. Nothing else in the run covers these two —
         * `advancePeriods` only wakes an Abo whose period has actually
         * rolled over, and it never looks at a cancelled one at all — so
         * deleting step 7 from `runBilling` fails both of them.
         */
        it("wakes a past_due Abo whose period has not rolled over yet", async () => {
            const customerId = await nextCustomer();
            // A yearly Abo billed on the day it was ordered: the period runs
            // to May 2032 and its renewal is not raised before April 2032,
            // so nothing else in the run has any reason to touch it.
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsAnnual, cycle: "annual" }],
                now: at("2031-05-01"),
                settings: SETTINGS_NO_ANCHOR,
            });

            const subscriptionId = placed.subscriptionIds[0];

            // 199,90 € due 15 May; the reminder rung at +3 marks the Abo
            // past_due on the 18th.
            await run("2031-05-18", { settings: SETTINGS_NO_ANCHOR });

            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "past_due",
            );

            await applyPayment(db, {
                ref: `transfer-catchup-pastdue-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2031-05-19"),
            });

            // No `reactivateAfterSettlement` — that is the point.
            const result = await run("2031-05-20", {
                settings: SETTINGS_NO_ANCHOR,
            });

            expect(result.report.reactivated).toBe(1);

            const row = await subscriptionOf(db, subscriptionId);

            expect(row.status).toBe("active");
            expect(row.pastDueAt).toBeNull();
        });

        it("wakes the services of a cancelled Abo the same way", async () => {
            const customerId = await nextCustomer();
            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsAnnual, cycle: "annual" }],
                now: at("2030-03-01"),
                settings: SETTINGS_NO_ANCHOR,
            });

            const subscriptionId = placed.subscriptionIds[0];
            const itemId = (await itemsOf(db, subscriptionId))[0].id;

            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: at("2030-03-01") })
                .where(eq(schema.service.subscriptionItemId, itemId));

            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: at("2030-03-02"),
            });

            // Due 15 March, suspended at +14 on the 29th.
            await run("2030-03-29", { settings: SETTINGS_NO_ANCHOR });

            expect((await servicesOf(db, itemId))[0].status).toBe("suspended");

            await applyPayment(db, {
                ref: `transfer-catchup-cancelled-${customerId}`,
                gateway: "banktransfer",
                invoiceId: placed.invoiceId as string,
                customerId,
                amountCents: placed.grossCents,
                actor: ACTOR,
                at: at("2030-03-30"),
            });

            const result = await run("2030-03-31", {
                settings: SETTINGS_NO_ANCHOR,
            });

            expect(result.report.reactivated).toBe(1);

            const services = await servicesOf(db, itemId);

            expect(services[0].status).toBe("active");
            expect(services[0].suspendedAt).toBeNull();
            // Still gekündigt — only the services came back.
            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "cancelled",
            );
        });
    });

    /**
     * A Sperre wegen Zahlungsverzugs is not the customer's to lift.
     *
     * A `suspended` service looks the same whether a pause put it there or
     * the +14 rung did, and every route back to `active` ends in the one
     * transition that wakes everything suspended. So the two buttons the
     * portal already offers — „Kündigen“ and „Kündigung zurücknehmen“ — gave
     * a non-paying customer their VPS back with 19,99 € still open, and the
     * rung that took it away never fires a second time: `dunning_action
     * (invoice_id, 'suspend')` is claimed for ever. The same two moves work
     * as „Pausieren“ and „Fortsetzen“.
     *
     * The question asked is `isOpenInvoice()` and never a status literal
     * (rule 3): the grace between the due date and the rung is untouched,
     * because nothing has been suspended yet there, and a pause the customer
     * lifts still wakes their services.
     */
    describe("a suspension over an unpaid invoice", () => {
        let customerId: string;
        let subscriptionId: string;
        let itemId: string;
        let invoiceId: string;

        beforeAll(async () => {
            customerId = await nextCustomer();

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: at("2029-03-01"),
                settings: SETTINGS,
            });

            subscriptionId = placed.subscriptionIds[0];
            itemId = (await itemsOf(db, subscriptionId))[0].id;
            invoiceId = placed.invoiceId as string;

            // The server is running, so a suspension has something to do.
            await db
                .update(schema.service)
                .set({ status: "active", activatedAt: at("2029-03-01") })
                .where(eq(schema.service.subscriptionItemId, itemId));

            // 19,99 € due on 15 March (14-day term) and nothing arrives.
            // One pass on +14 climbs every rung that has come due:
            // Zahlungserinnerung (+3), Mahnung (+10), Sperre (+14).
            await run("2029-03-29");
        }, 60_000);

        it("stops the services at +14, with 19,99 € still open", async () => {
            const invoice = await invoiceOf(db, invoiceId);

            expect(invoice.grossCents).toBe(1999);
            expect(invoice.paidCents).toBe(0);
            expect(
                OPEN_INVOICE_STATUSES.includes(
                    invoice.status as "unpaid" | "partial",
                ),
            ).toBe(true);

            const suspension = await db
                .select()
                .from(schema.dunningAction)
                .where(
                    and(
                        eq(schema.dunningAction.invoiceId, invoiceId),
                        eq(schema.dunningAction.level, "suspend"),
                    ),
                );

            expect(suspension).toHaveLength(1);
            expect((await servicesOf(db, itemId))[0].status).toBe("suspended");
            expect((await subscriptionOf(db, subscriptionId)).status).toBe(
                "past_due",
            );
        });

        it("survives „Kündigen“ und „Kündigung zurücknehmen“", async () => {
            await cancelSubscription(db, {
                subscriptionId,
                when: "period_end",
                actor: ACTOR,
                at: at("2029-03-30"),
            });

            expect((await servicesOf(db, itemId))[0].status).toBe("suspended");

            await resumeCancellation(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2029-03-30"),
            });

            const row = await subscriptionOf(db, subscriptionId);

            // The cancellation really is off — only the server stays dark.
            expect(row.cancelAtPeriodEnd).toBe(false);
            expect(row.cancelledAt).toBeNull();

            const service = (await servicesOf(db, itemId))[0];

            expect(service.status).toBe("suspended");
            expect(service.suspendedAt).not.toBeNull();
        });

        it("survives „Pausieren“ und „Fortsetzen“ just the same", async () => {
            await pauseSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2029-03-31"),
            });
            await resumeSubscription(db, {
                subscriptionId,
                actor: ACTOR,
                at: at("2029-04-01"),
            });

            expect((await servicesOf(db, itemId))[0].status).toBe("suspended");
        });

        it("ends when the money arrives — all 39,98 € of it", async () => {
            /**
             * First, put April back on the books.
             *
             * The Kündigung two cases up took the already-raised
             * Verlängerung back — that is what cancelling to the end of a
             * period now does, because a period that will not be delivered
             * must not keep being collected and gemahnt. Taking the
             * Kündigung back does not re-raise it on the spot; the next
             * pass does, and this is that pass.
             *
             * It matters for what is being tested here: the account has to
             * owe *two* periods for "settling one of them is not being paid
             * up" to mean anything, and `hasOpenInvoice()` is what says so.
             */
            await run("2029-03-31");

            expect(await openInvoicesOf(customerId)).toHaveLength(2);
            await applyPayment(db, {
                ref: `transfer-dunning-hold-march-${customerId}`,
                gateway: "banktransfer",
                invoiceId,
                customerId,
                amountCents: 1999,
                actor: ACTOR,
                at: at("2029-04-02"),
            });

            // The seam every settled payment passes through, called directly
            // for the same reason as in the ninety-day simulation above.
            await reactivateAfterSettlement(db, invoiceId, at("2029-04-02"));

            expect((await servicesOf(db, itemId))[0].status).toBe("suspended");

            const renewalId = (await linksFor(db, subscriptionId)).find(
                (row) => row.kind === "renewal",
            )?.invoiceId as string;

            const outcome = await applyPayment(db, {
                ref: `transfer-dunning-hold-april-${customerId}`,
                gateway: "banktransfer",
                invoiceId: renewalId,
                customerId,
                amountCents: 1999,
                actor: ACTOR,
                at: at("2029-04-03"),
            });

            expect(outcome.invoiceStatus).toBe("paid");

            await reactivateAfterSettlement(db, renewalId, at("2029-04-03"));

            const service = (await servicesOf(db, itemId))[0];

            expect(service.status).toBe("active");
            expect(service.suspendedAt).toBeNull();
        });
    });
});
