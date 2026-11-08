import "server-only";
import {
    and,
    asc,
    eq,
    exists,
    inArray,
    isNotNull,
    isNull,
    lte,
    notExists,
    or,
    sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { type db as defaultDb, schema } from "@/db";
import {
    type BillingCycle,
    type Coupon,
    type DunningLevel,
    isOpenInvoice,
    OPEN_INVOICE_STATUSES,
    type Subscription,
    type SubscriptionItem,
} from "@/db/schema";
import { berlinDay } from "@/lib/berlin-date";
import { add, subtract } from "@/lib/money";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import {
    createInvoiceDraftIn,
    finalizeInvoiceIn,
    type InvoiceItemInput,
    resolveFinalizeOptions,
} from "@/server/billing/invoices/service";
import { periodAfter } from "@/server/billing/periods";
import type { QuoteSelection } from "@/server/billing/pricing";
import { renewalCoupon, renewalLines } from "@/server/billing/renewal";
import { creditBalanceCents, payFromCredit } from "@/server/payments/apply";
import { collectIssuedInvoice } from "@/server/payments/collect";
import { emitInvoicePaid } from "@/server/payments/settle";
import { loadSettings, type Settings } from "@/server/settings";
import {
    applyDueChangesIn,
    type ChangeTarget,
} from "@/server/subscriptions/changes";
import {
    applyServiceFollow,
    lockSubscription,
    recordEvent,
    transitionSubscriptionIn,
    wakeSettledIn,
} from "@/server/subscriptions/service";
import { BILLABLE_STATUSES, canTransition } from "@/server/subscriptions/state";
import { collectionDue, DUNNING_LABEL, dunningDue } from "./dunning";
import {
    sendDunningNotice,
    sendRenewalNotice,
    sendTrialEndingNotice,
} from "./notices";

/**
 * `billing:run` — the daily pass, and the first thing in this project that
 * takes money with nobody watching.
 *
 * Seven steps, in this order and for this reason:
 *
 *   1. trials end            — a trial that is over is an Abo that bills
 *   2. renewals are invoiced — N days ahead, grouped per customer, credit applied
 *   3. due invoices are collected — the retry ladder, d+0 / d+3 / d+7
 *   4. periods advance       — **only** where the renewal was dealt with
 *   5. dunning               — reminder, Mahnung, suspension, termination
 *   6. cancellations close   — cancel_at_period_end, and spent coupons
 *   7. settled Abos wake up  — the mirror of (5), for anything the payment
 *                              seam missed
 *
 * **Nothing here is safe because it runs once a day.** It is safe because
 * every step claims a row before it acts, under a unique index that only one
 * claimant can pass:
 *
 *   step 2 → `subscription_invoice (subscription_id, period_start, kind)`
 *   step 3 → `invoice_collection   (invoice_id, offset_days)`
 *   step 5 → `dunning_action       (invoice_id, level)`
 *
 * and every one of those claims is taken inside a transaction that holds the
 * subscription or the invoice row `FOR UPDATE` first. Two workers, a retried
 * job and an operator pressing "jetzt abrechnen" at the same moment all
 * queue behind one another and only one of them does the work. `billing_run`
 * is the *cheap* layer on top: it keeps a second cron pass off the database
 * and gives the Jobs page something to show. It is deliberately the only one
 * of the four a human may bypass.
 *
 * Each step walks its own list and opens one transaction per customer or per
 * invoice, so one customer whose card provider is down does not roll back
 * everybody else's renewal. What failed is counted and reported; the run
 * itself finishes.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const SYSTEM: Actor = { type: "system", label: "billing:run" };
const DAY_MS = 86_400_000;

export type BillingRunContext = {
    now: Date;
    settings: Settings;
    actor: Actor;
    /** Narrow the whole run to one account — used by the admin button. */
    customerId?: string | null;
    /**
     * Whether to render the PDF of each invoice as it is issued.
     *
     * True in the web process, where the renderer is already loaded and the
     * operator expects a finished document. **False in the worker**, and
     * deliberately: `@react-pdf/renderer` reaches a dependency whose
     * subpaths publish only an `import` condition, so requiring it from a
     * plain Node process fails outright — and forcing the `import`
     * condition globally is what breaks node-postgres (see the note in
     * `vitest.config.mts`).
     *
     * Nothing is lost by it. `invoicePdf()` renders and stores the document
     * on first access, write-once, so the customer's copy is identical
     * whichever process produced it; the renewal notice links to the invoice
     * page rather than attaching a file, so nobody waits for it.
     */
    renderPdf?: boolean;
};

/**
 * Renders and stores a finalized document, if this process can.
 *
 * Imported at the point of use rather than at the top of the file: the
 * worker must be able to *load* this module without the PDF renderer being
 * resolvable at all.
 */
async function renderDocument(db: Db, invoiceId: string, enabled: boolean) {
    if (!enabled) {
        return;
    }

    try {
        const { storeFinalizedPdf } = await import(
            "@/server/billing/invoices/pdf"
        );

        await storeFinalizedPdf(db, "invoice", invoiceId);
    } catch (error) {
        // Never fatal: the document exists, and it is rendered on first
        // access anyway.
        console.error("[billing:run] rendering the invoice failed:", error);
    }
}

export type StepFailure = {
    step: string;
    entityId: string;
    message: string;
};

export type BillingRunReport = {
    day: string;
    trialsEnded: number;
    trialNoticesSent: number;
    invoicesIssued: number;
    invoicedCents: number;
    creditAppliedCents: number;
    collectionsAttempted: number;
    collectionsSucceeded: number;
    periodsAdvanced: number;
    subscriptionsPastDue: number;
    dunningActions: number;
    servicesSuspended: number;
    subscriptionsEnded: number;
    couponsExpired: number;
    reactivated: number;
    failures: StepFailure[];
};

function emptyReport(day: string): BillingRunReport {
    return {
        day,
        trialsEnded: 0,
        trialNoticesSent: 0,
        invoicesIssued: 0,
        invoicedCents: 0,
        creditAppliedCents: 0,
        collectionsAttempted: 0,
        collectionsSucceeded: 0,
        periodsAdvanced: 0,
        subscriptionsPastDue: 0,
        dunningActions: 0,
        servicesSuspended: 0,
        subscriptionsEnded: 0,
        couponsExpired: 0,
        reactivated: 0,
        failures: [],
    };
}

export type BillingRunResult = {
    /** False when another pass already holds the day and no force was asked. */
    ran: boolean;
    runId: string | null;
    report: BillingRunReport;
};

/**
 * Did this row come from a pass that *threw*?
 *
 * `status` cannot say on its own: `failed` is written both by a pass that
 * walked all seven steps and could not bill somebody — that pass **finished**
 * — and by `runBilling`'s catch for a pass that died. `error` is the
 * discriminator, because only the catch writes one: a run that finishes puts
 * what it could not do in `report.failures` and leaves `error` empty.
 *
 * The difference is the one that decides whether the day may be done again.
 */
export function billingRunThrew(row: {
    status: "running" | "finished" | "failed";
    error: string | null;
}): boolean {
    return row.status === "failed" && row.error !== null;
}

/**
 * Claims the day, or reports that somebody else has it.
 *
 * `on conflict do nothing` is the claim. Two rows are no claim worth
 * respecting, and for the same reason — the day was never done:
 *
 *   - a pass that was **killed** leaves its row `running` for ever, so a
 *     `running` row older than an hour is taken over. An hour is far longer
 *     than a pass takes and far shorter than a day.
 *   - a pass that **threw** recorded the exception and rethrew without
 *     invoicing a renewal, claiming a collection rung or climbing a dunning
 *     level. pg-boss retries it three times, half an hour apart
 *     (`src/server/jobs/queues.ts`); those retries are the only mechanism
 *     that can still repair the day, and they have to get past here. A
 *     process that honestly wrote down why it died must not be *less*
 *     recoverable than one that was killed mid-write.
 *
 * A pass that finished with failures in its report is neither: it did the
 * day, some of it badly, and redoing it wholesale would send every notice it
 * did manage a second time. Its entities are retried by the next day's pass,
 * which finds their claims unmade.
 */
async function claimDay(
    db: Db,
    day: string,
    now: Date,
    force: boolean,
    forcedBy: string | null,
): Promise<string | null> {
    const id = createId("billingrun");

    const [claimed] = await db
        .insert(schema.billingRun)
        .values({
            id,
            runDay: day,
            status: "running",
            forced: force ? (forcedBy ?? "manuell") : null,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: schema.billingRun.id });

    if (claimed) {
        return claimed.id;
    }

    const [existing] = await db
        .select()
        .from(schema.billingRun)
        .where(eq(schema.billingRun.runDay, day));

    if (!existing) {
        return null;
    }

    const abandoned =
        existing.status === "running" &&
        now.getTime() - existing.startedAt.getTime() > 3_600_000;

    if (!force && !abandoned && !billingRunThrew(existing)) {
        return null;
    }

    await db
        .update(schema.billingRun)
        .set({
            status: "running",
            startedAt: now,
            finishedAt: null,
            error: null,
            forced: force ? (forcedBy ?? "manuell") : existing.forced,
            updatedAt: now,
        })
        .where(eq(schema.billingRun.id, existing.id));

    return existing.id;
}

export async function runBilling(
    db: Db,
    options: {
        now?: Date;
        force?: boolean;
        forcedBy?: string | null;
        settings?: Settings;
        customerId?: string | null;
        actor?: Actor;
        renderPdf?: boolean;
    } = {},
): Promise<BillingRunResult> {
    const now = options.now ?? new Date();
    const settings = options.settings ?? (await loadSettings());
    const day = berlinDay(now);
    const report = emptyReport(day);

    /**
     * A pass narrowed to one account does not take the day.
     *
     * `billing_run (run_day)` is the cheap layer that keeps a second cron
     * pass off the database — it speaks for *the whole night*, and only an
     * unscoped pass does that. Keyed on the bare day, an operator pressing
     * "jetzt abrechnen" for one customer at 02:00 would hand back a
     * finished row that the 03:00 cron then respects, and every other
     * customer's renewals, collections and Mahnstufen would be skipped
     * until the following night — one account billed, the rest silently
     * passed over.
     *
     * So a scoped pass claims a key of its own, `day#customer`. It is still
     * recorded, still visible under Aufträge and still idempotent for that
     * customer on that day; it simply makes no claim about anybody else.
     * What stops the customer being invoiced twice was never this row
     * anyway — it is the unique indexes underneath.
     */
    const claimKey = options.customerId ? `${day}#${options.customerId}` : day;

    const runId = await claimDay(
        db,
        claimKey,
        now,
        options.force ?? false,
        options.forcedBy ?? null,
    );

    if (!runId) {
        return { ran: false, runId: null, report };
    }

    const context: BillingRunContext = {
        now,
        settings,
        actor: options.actor ?? SYSTEM,
        customerId: options.customerId ?? null,
        renderPdf: options.renderPdf ?? true,
    };

    try {
        await endTrials(db, context, report);
        await issueRenewals(db, context, report);
        await collectDueInvoices(db, context, report);
        await advancePeriods(db, context, report);
        await runDunning(db, context, report);
        await closePeriodEndCancellations(db, context, report);
        await expireCoupons(db, context, report);
        await reactivateSettled(db, context, report);

        await db
            .update(schema.billingRun)
            .set({
                status: report.failures.length > 0 ? "failed" : "finished",
                finishedAt: new Date(),
                report,
                /**
                 * Explicitly: this pass finished. Whatever it could not bill
                 * is in `report.failures`, and `error` has to stay empty,
                 * because an empty `error` is what tells the next claimant
                 * that the day was done — see `billingRunThrew`.
                 */
                error: null,
                updatedAt: new Date(),
            })
            .where(eq(schema.billingRun.id, runId));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await db
            .update(schema.billingRun)
            .set({
                status: "failed",
                finishedAt: new Date(),
                report,
                error: message,
                updatedAt: new Date(),
            })
            .where(eq(schema.billingRun.id, runId));

        throw error;
    }

    return { ran: true, runId, report };
}

/** Narrows every step to one account when the operator asked for one. */
function scopedTo(context: BillingRunContext, column: AnyPgColumn) {
    return context.customerId ? eq(column, context.customerId) : undefined;
}

function note(
    report: BillingRunReport,
    step: string,
    entityId: string,
    error: unknown,
) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`[billing:run] ${step} failed for ${entityId}:`, error);
    report.failures.push({ step, entityId, message });
}

/** The address a notice goes to: the account's owner contact. */
async function contactEmail(
    executor: Db | Tx,
    customerId: string,
): Promise<string | null> {
    const [row] = await executor
        .select({ email: schema.customerContact.email })
        .from(schema.customerContact)
        .where(eq(schema.customerContact.customerId, customerId))
        .orderBy(
            sql`case when ${schema.customerContact.role} = 'owner' then 0 else 1 end`,
            asc(schema.customerContact.id),
        )
        .limit(1);

    return row?.email ?? null;
}

// ---------------------------------------------------------------------------
// 1 — trials
// ---------------------------------------------------------------------------

/**
 * A trial whose free days are over becomes an ordinary active Abo. The
 * invoice for its first paid period was raised by step 2 some days ago —
 * `next_billing_at` is the end of the trial, and the lead time runs
 * backwards from there — so this step moves the status and nothing else.
 *
 * It also sends the "Ihre Testphase endet" notice while there are still days
 * left, which is the one piece of the plan a customer actually asks for.
 */
export async function endTrials(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now } = context;

    const ending = await db
        .select()
        .from(schema.subscription)
        .where(
            and(
                eq(schema.subscription.status, "trialing"),
                isNotNull(schema.subscription.trialEndsAt),
                lte(schema.subscription.trialEndsAt, now),
                scopedTo(context, schema.subscription.customerId),
            ),
        )
        .orderBy(asc(schema.subscription.id));

    for (const row of ending) {
        try {
            await db.transaction(async (tx) => {
                const result = await transitionSubscriptionIn(tx, {
                    subscriptionId: row.id,
                    to: "active",
                    summary: "Testphase beendet.",
                    actor: context.actor,
                    at: now,
                });

                if (result.changed) {
                    report.trialsEnded += 1;
                }
            });
        } catch (error) {
            note(report, "trials", row.id, error);
        }
    }

    // The warning, for trials that are still running but end within the lead
    // time. One per trial, because `trial_notice` would be a table for a
    // single boolean — the event row is the marker.
    const soon = await db
        .select()
        .from(schema.subscription)
        .where(
            and(
                eq(schema.subscription.status, "trialing"),
                isNotNull(schema.subscription.trialEndsAt),
                lte(
                    schema.subscription.trialEndsAt,
                    new Date(
                        now.getTime() +
                            context.settings.billing.renewalLeadDays * DAY_MS,
                    ),
                ),
                scopedTo(context, schema.subscription.customerId),
            ),
        )
        .orderBy(asc(schema.subscription.id));

    for (const row of soon) {
        try {
            const sent = await db.transaction(async (tx) => {
                const [already] = await tx
                    .select({ id: schema.subscriptionEvent.id })
                    .from(schema.subscriptionEvent)
                    .where(
                        and(
                            eq(schema.subscriptionEvent.subscriptionId, row.id),
                            eq(schema.subscriptionEvent.kind, "note"),
                            eq(
                                schema.subscriptionEvent.summary,
                                "Hinweis auf das Ende der Testphase verschickt.",
                            ),
                        ),
                    )
                    .limit(1);

                if (already) {
                    return false;
                }

                await recordEvent(tx, {
                    subscriptionId: row.id,
                    kind: "note",
                    summary: "Hinweis auf das Ende der Testphase verschickt.",
                    actor: context.actor,
                    at: now,
                });

                return true;
            });

            if (!sent) {
                continue;
            }

            const to = await contactEmail(db, row.customerId);
            const items = await db
                .select()
                .from(schema.subscriptionItem)
                .where(eq(schema.subscriptionItem.subscriptionId, row.id))
                .orderBy(asc(schema.subscriptionItem.position));

            if (to && row.trialEndsAt) {
                await sendTrialEndingNotice({
                    to,
                    subscriptionId: row.id,
                    label: items[0]?.description ?? "Ihr Abo",
                    amountCents: add(
                        ...items.map((item) => item.recurringGrossCents),
                    ),
                    chargeAt: row.trialEndsAt,
                });
            }

            report.trialNoticesSent += 1;
        } catch (error) {
            note(report, "trial-notice", row.id, error);
        }
    }
}

// ---------------------------------------------------------------------------
// 2 — renewals
// ---------------------------------------------------------------------------

type RenewalCandidate = {
    subscription: Subscription;
    leadDays: number;
};

/**
 * How many days before the period this subscription's invoice goes out: the
 * longest any of its products asks for, and the portal's setting where none
 * does. The longest, because an invoice that arrives early is a notice and
 * one that arrives late is a surprise.
 */
async function leadDaysFor(
    executor: Db | Tx,
    subscriptionId: string,
    fallback: number,
): Promise<number> {
    const [row] = await executor
        .select({
            days: sql<number | null>`max(${schema.product.renewalLeadDays})`,
        })
        .from(schema.subscriptionItem)
        .innerJoin(
            schema.product,
            eq(schema.subscriptionItem.productId, schema.product.id),
        )
        .where(eq(schema.subscriptionItem.subscriptionId, subscriptionId));

    return Math.max(row?.days ?? fallback, fallback);
}

export async function issueRenewals(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now, settings } = context;
    const horizon = new Date(
        now.getTime() +
            Math.max(
                settings.billing.renewalLeadDays,
                // A product may ask for a longer lead than the portal's, so
                // the first pass has to look that far ahead or it would never
                // see the row at all.
                await longestProductLead(db, settings.billing.renewalLeadDays),
            ) *
                DAY_MS,
    );

    const due = await db
        .select()
        .from(schema.subscription)
        .where(
            and(
                inArray(schema.subscription.status, [...BILLABLE_STATUSES]),
                eq(schema.subscription.cancelAtPeriodEnd, false),
                isNotNull(schema.subscription.nextBillingAt),
                lte(schema.subscription.nextBillingAt, horizon),
                scopedTo(context, schema.subscription.customerId),
            ),
        )
        .orderBy(asc(schema.subscription.id));

    const candidates: RenewalCandidate[] = [];

    for (const subscription of due) {
        const leadDays = await leadDaysFor(
            db,
            subscription.id,
            settings.billing.renewalLeadDays,
        );

        if (
            !subscription.nextBillingAt ||
            subscription.nextBillingAt.getTime() >
                now.getTime() + leadDays * DAY_MS
        ) {
            continue;
        }

        candidates.push({ subscription, leadDays });
    }

    /**
     * Grouped per customer, currency **and billing day**. The plan asks for
     * customer and currency; the day is here because an invoice has one due
     * date, and bundling two subscriptions that fall due a fortnight apart
     * would make one of the two figures wrong. With a billing anchor set
     * every subscription falls on the same day anyway, which is the case the
     * grouping is for.
     */
    const groups = new Map<string, RenewalCandidate[]>();

    for (const candidate of candidates) {
        const key = [
            candidate.subscription.customerId,
            candidate.subscription.currency,
            // biome-ignore lint/style/noNonNullAssertion: filtered above
            berlinDay(candidate.subscription.nextBillingAt!),
        ].join("|");

        const bucket = groups.get(key);

        if (bucket) {
            bucket.push(candidate);
        } else {
            groups.set(key, [candidate]);
        }
    }

    for (const [key, bucket] of groups) {
        try {
            const issued = await issueRenewalGroup(db, context, bucket);

            if (!issued) {
                continue;
            }

            report.invoicesIssued += 1;
            report.invoicedCents = add(report.invoicedCents, issued.grossCents);

            // Outside the transaction, deliberately: rendering takes a few
            // hundred milliseconds and would hold the number counter's lock
            // for every one of them.
            await renderDocument(
                db,
                issued.invoiceId,
                context.renderPdf ?? true,
            );

            const applied = await applyCreditToInvoice(db, {
                invoiceId: issued.invoiceId,
                customerId: issued.customerId,
                at: now,
                actor: context.actor,
            });

            report.creditAppliedCents = add(report.creditAppliedCents, applied);

            const to = await contactEmail(db, issued.customerId);

            if (to) {
                await sendRenewalNotice({
                    to,
                    invoiceId: issued.invoiceId,
                    invoiceNumber: issued.number,
                    amountCents: issued.grossCents,
                    dueAt: issued.dueAt,
                    autoCharge: issued.autoCharge,
                });
            }
        } catch (error) {
            note(report, "renewal", key, error);
        }
    }
}

/** The longest lead any product in the catalog asks for. */
async function longestProductLead(db: Db, fallback: number): Promise<number> {
    const [row] = await db
        .select({
            days: sql<number | null>`max(${schema.product.renewalLeadDays})`,
        })
        .from(schema.product);

    return Math.max(row?.days ?? fallback, fallback);
}

type IssuedRenewal = {
    invoiceId: string;
    number: string;
    customerId: string;
    grossCents: number;
    dueAt: Date;
    autoCharge: boolean;
};

/**
 * One customer, one currency, one billing day, one invoice.
 *
 * The transaction locks every subscription in the group `FOR UPDATE`, in id
 * order — the same order every pass builds its list in, so two runs cannot
 * deadlock against each other — and only then reads what it is going to
 * bill. A second pass racing this one blocks on the first lock and then
 * finds the `subscription_invoice` row already there.
 */
async function issueRenewalGroup(
    db: Db,
    context: BillingRunContext,
    bucket: RenewalCandidate[],
): Promise<IssuedRenewal | null> {
    const { now, settings } = context;
    const ordered = [...bucket].sort((a, b) =>
        a.subscription.id.localeCompare(b.subscription.id),
    );

    const finalizeOptions = await resolveFinalizeOptions({ now, settings });

    return db.transaction(async (tx) => {
        const lines: InvoiceItemInput[] = [];
        const links: {
            subscriptionId: string;
            periodStart: Date;
            periodEnd: Date | null;
            netCents: number;
        }[] = [];

        let dueAt: Date | null = null;
        let autoCharge = false;
        let customerId: string | null = null;

        for (const candidate of ordered) {
            const row = await lockSubscription(tx, candidate.subscription.id);

            if (
                !row.nextBillingAt ||
                row.cancelAtPeriodEnd ||
                !BILLABLE_STATUSES.includes(row.status) ||
                row.nextBillingAt.getTime() >
                    now.getTime() + candidate.leadDays * DAY_MS
            ) {
                continue;
            }

            const periodStart = row.nextBillingAt;

            const [already] = await tx
                .select({ id: schema.subscriptionInvoice.id })
                .from(schema.subscriptionInvoice)
                .where(
                    and(
                        eq(schema.subscriptionInvoice.subscriptionId, row.id),
                        eq(schema.subscriptionInvoice.periodStart, periodStart),
                        eq(schema.subscriptionInvoice.kind, "renewal"),
                    ),
                );

            if (already) {
                continue;
            }

            const period = periodAfter({
                start: periodStart,
                cycle: row.cycle,
                trialEndsAt: row.trialEndsAt,
                anchorDay: settings.policy.billingAnchorDay,
            });
            const built = await buildRenewalLines(tx, row, period, now);

            if (built.lines.length === 0 || built.netCents === 0) {
                /**
                 * Nothing to charge — everything on this Abo is discounted
                 * to zero for this period. No document is issued, because a
                 * 0,00 € invoice burns a gapless number on a demand for
                 * nothing.
                 *
                 * This event is therefore the only record that the period
                 * was dealt with at all, and `invoiced: false` is what makes
                 * it one: step 4 reads it as the positive statement "nothing
                 * was owed here", which is what tells this case apart from a
                 * renewal that was never raised because this step threw.
                 */
                await recordEvent(tx, {
                    subscriptionId: row.id,
                    kind: "period",
                    summary:
                        "Verlängerung ohne Rechnung: für diesen Zeitraum ist nichts zu zahlen.",
                    data: {
                        periodStart: periodStart.toISOString(),
                        invoiced: false,
                    },
                    actor: context.actor,
                    at: now,
                });

                await consumeDiscountPeriod(tx, row, now);
                continue;
            }

            customerId = row.customerId;
            autoCharge = autoCharge || row.autoCharge;
            dueAt =
                dueAt === null || periodStart.getTime() < dueAt.getTime()
                    ? periodStart
                    : dueAt;

            lines.push(...built.lines);
            links.push({
                subscriptionId: row.id,
                periodStart,
                periodEnd: period.end,
                netCents: built.netCents,
            });

            await consumeDiscountPeriod(tx, row, now);
        }

        if (lines.length === 0 || !customerId || !dueAt) {
            return null;
        }

        const draft = await createInvoiceDraftIn(
            tx,
            {
                customerId,
                introText: "Zur Verlängerung Ihrer Leistungen.",
                items: lines,
            },
            context.actor,
        );

        const finalized = await finalizeInvoiceIn(tx, draft.id, context.actor, {
            ...finalizeOptions,
            // The invoice is raised ahead of the period and falls due on the
            // day the period starts — which is also the day the retry ladder
            // and dunning are reckoned from.
            dueAt,
        });

        for (const link of links) {
            await tx.insert(schema.subscriptionInvoice).values({
                id: createId("subscriptioninvoice"),
                subscriptionId: link.subscriptionId,
                invoiceId: draft.id,
                kind: "renewal",
                periodStart: link.periodStart,
                periodEnd: link.periodEnd,
                netCents: link.netCents,
            });

            await recordEvent(tx, {
                subscriptionId: link.subscriptionId,
                kind: "period",
                summary: `Verlängerung berechnet: Rechnung ${finalized.number}.`,
                data: {
                    invoiceId: draft.id,
                    invoiceNumber: finalized.number,
                    periodStart: link.periodStart.toISOString(),
                    netCents: link.netCents,
                },
                actor: context.actor,
                at: now,
            });
        }

        await audit(tx, {
            actor: context.actor,
            action: "billing.renewal",
            entityType: "invoice",
            entityId: draft.id,
            after: {
                number: finalized.number,
                customerId,
                subscriptions: links.map((link) => link.subscriptionId),
                grossCents: finalized.totals.grossCents,
                dueAt: dueAt.toISOString(),
            },
        });

        return {
            invoiceId: draft.id,
            number: finalized.number,
            customerId,
            grossCents: finalized.totals.grossCents,
            dueAt,
            autoCharge,
        };
    });
}

/**
 * Counts one period off the coupon.
 *
 * It happens when the invoice is *raised*, because that invoice is where the
 * discount is granted — a renewal issued a fortnight early for the last
 * discounted period would otherwise be followed by another discounted one.
 * `cancelRenewalInvoice()` puts it back, which is the mirror.
 */
async function consumeDiscountPeriod(tx: Tx, row: Subscription, at: Date) {
    if (row.discountPeriodsRemaining === null) {
        return;
    }

    await tx
        .update(schema.subscription)
        .set({
            discountPeriodsRemaining: Math.max(
                row.discountPeriodsRemaining - 1,
                0,
            ),
            updatedAt: at,
        })
        .where(eq(schema.subscription.id, row.id));
}

/**
 * The lines one subscription contributes to a renewal invoice, priced at
 * the configuration the period being billed will actually run on.
 *
 * It **reads** the changes agreed for that period and writes none of them.
 * This runs `renewalLeadDays` before the period starts, and the item is the
 * running one: rewriting it here would move the services a fortnight early
 * and terminate a machine the customer has paid for to the last day of the
 * period — which "a terminated service stays terminated" makes permanent,
 * and which no reversal can undo. The lines are the next period's, so they
 * take the new configuration; the item and its services follow at
 * `apply_at`, in `advancePeriods()`.
 */
async function buildRenewalLines(
    tx: Tx,
    row: Subscription,
    period: ReturnType<typeof periodAfter>,
    now: Date,
): Promise<{ lines: InvoiceItemInput[]; netCents: number }> {
    const pending = await tx
        .select()
        .from(schema.subscriptionChange)
        .where(
            and(
                eq(schema.subscriptionChange.subscriptionId, row.id),
                eq(schema.subscriptionChange.status, "pending"),
                lte(schema.subscriptionChange.applyAt, period.start),
            ),
        )
        .orderBy(asc(schema.subscriptionChange.id));

    /**
     * What each position will look like once the period has begun. In id
     * order, so the last change agreed on a position is the one billed —
     * the same order `applyDueChangesIn()` writes them in.
     */
    const agreed = new Map<string, ChangeTarget>();

    for (const change of pending) {
        agreed.set(change.subscriptionItemId, {
            productId: change.productId,
            description: change.description,
            quantity: change.quantity,
            unitPriceCents: change.unitPriceCents,
            recurringGrossCents: change.recurringGrossCents,
            selections: change.selections as QuoteSelection[],
        });
    }

    const items: SubscriptionItem[] = await tx
        .select()
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.subscriptionId, row.id))
        .orderBy(asc(schema.subscriptionItem.position));

    let coupon: Coupon | null = null;

    if (row.couponId) {
        const [found] = await tx
            .select()
            .from(schema.coupon)
            .where(eq(schema.coupon.id, row.couponId));

        coupon = found ?? null;
    }

    const quoteCoupon = renewalCoupon({
        coupon,
        periodsRemaining: row.discountPeriodsRemaining,
        now,
    });

    const lines: InvoiceItemInput[] = [];
    let netCents = 0;

    for (const item of items) {
        const target = agreed.get(item.id);

        const built = renewalLines({
            item: {
                id: item.id,
                productId: target?.productId ?? item.productId,
                description: target?.description ?? item.description,
                quantity: target?.quantity ?? item.quantity,
                unitPriceCents: target?.unitPriceCents ?? item.unitPriceCents,
                selections: (target?.selections ??
                    item.selections) as QuoteSelection[],
            },
            cycle: row.cycle as BillingCycle,
            currency: row.currency,
            coupon: quoteCoupon,
            period,
            now,
        });

        lines.push(...built.lines);
        netCents = add(netCents, built.netCents);
    }

    return { lines, netCents };
}

/**
 * Spends whatever the account has on the invoice that was just issued.
 *
 * It goes through `payFromCredit` — the same path the customer's own
 * "Guthaben anrechnen" button takes — so the balance leaves the ledger and
 * the invoice is settled by `applyPayment` exactly as a card payment is.
 * Writing a "Guthaben" line onto the invoice instead would be a second way
 * for an invoice to be paid, and two ways is how one gets paid twice.
 */
async function applyCreditToInvoice(
    db: Db,
    input: {
        invoiceId: string;
        customerId: string;
        at: Date;
        actor: Actor;
    },
): Promise<number> {
    const balance = await creditBalanceCents(db, input.customerId);

    if (balance <= 0) {
        return 0;
    }

    const [invoice] = await db
        .select({
            status: schema.invoice.status,
            grossCents: schema.invoice.grossCents,
            creditedCents: schema.invoice.creditedCents,
            paidCents: schema.invoice.paidCents,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.id, input.invoiceId));

    if (!invoice || !isOpenInvoice(invoice.status)) {
        return 0;
    }

    const outstanding = subtract(
        Math.max(subtract(invoice.grossCents ?? 0, invoice.creditedCents), 0),
        invoice.paidCents,
    );

    const amountCents = Math.min(balance, outstanding);

    if (amountCents <= 0) {
        return 0;
    }

    const outcome = await payFromCredit(db, {
        invoiceId: input.invoiceId,
        customerId: input.customerId,
        amountCents,
        actor: input.actor,
        at: input.at,
    });

    if (!outcome.changed) {
        return 0;
    }

    await emitInvoicePaid(outcome, input.at);

    return amountCents;
}

// ---------------------------------------------------------------------------
// 3 — collection
// ---------------------------------------------------------------------------

/**
 * The retry ladder. Each rung is claimed in the database before the gateway
 * is called, never after: a worker that dies between the charge and the
 * bookkeeping must not leave an unclaimed rung for the next pass to charge
 * again.
 */
export async function collectDueInvoices(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now, settings } = context;

    const open = await db
        .selectDistinct({
            invoiceId: schema.invoice.id,
            dueAt: schema.invoice.dueAt,
            customerId: schema.invoice.customerId,
        })
        .from(schema.invoice)
        .innerJoin(
            schema.subscriptionInvoice,
            eq(schema.subscriptionInvoice.invoiceId, schema.invoice.id),
        )
        .innerJoin(
            schema.subscription,
            eq(
                schema.subscriptionInvoice.subscriptionId,
                schema.subscription.id,
            ),
        )
        .where(
            and(
                inArray(schema.invoice.status, [...OPEN_INVOICE_STATUSES]),
                isNotNull(schema.invoice.dueAt),
                lte(schema.invoice.dueAt, now),
                eq(schema.subscription.autoCharge, true),
                scopedTo(context, schema.invoice.customerId),
            ),
        )
        .orderBy(asc(schema.invoice.id));

    for (const row of open) {
        if (!row.dueAt) {
            continue;
        }

        const rungs = collectionDue(row.dueAt, now, settings.billing);

        for (const rung of rungs) {
            try {
                const claimed = await claimCollection(db, {
                    invoiceId: row.invoiceId,
                    offsetDays: rung.offsetDays,
                    dueAt: rung.at,
                });

                if (!claimed) {
                    continue;
                }

                report.collectionsAttempted += 1;

                const outcome = await collectIssuedInvoice(row.invoiceId, {
                    type: "system",
                    label: "billing:run",
                });

                const status = !outcome.attempted
                    ? "skipped"
                    : outcome.status === "succeeded"
                      ? "succeeded"
                      : outcome.status === "processing"
                        ? "processing"
                        : outcome.status === "requires_action"
                          ? "requires_action"
                          : "failed";

                if (status === "succeeded") {
                    report.collectionsSucceeded += 1;
                }

                await db
                    .update(schema.invoiceCollection)
                    .set({
                        status,
                        attemptedAt: new Date(),
                        detail:
                            outcome.attempted && outcome.status === "failed"
                                ? outcome.reason
                                : null,
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.invoiceCollection.id, claimed));

                // A rung that succeeded ends the ladder for this invoice.
                if (status === "succeeded") {
                    break;
                }
            } catch (error) {
                note(report, "collection", row.invoiceId, error);
            }
        }
    }
}

/** `on conflict do nothing` — the rung, claimed, or somebody else has it. */
async function claimCollection(
    db: Db,
    input: { invoiceId: string; offsetDays: number; dueAt: Date },
): Promise<string | null> {
    const id = createId("invoicecollection");

    const [claimed] = await db
        .insert(schema.invoiceCollection)
        .values({
            id,
            invoiceId: input.invoiceId,
            offsetDays: input.offsetDays,
            status: "claimed",
            dueAt: input.dueAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.invoiceCollection.id });

    return claimed?.id ?? null;
}

// ---------------------------------------------------------------------------
// 4 — periods
// ---------------------------------------------------------------------------

/**
 * A period that has run out either rolls over or does not.
 *
 * **Only when it was dealt with**, which is two questions rather than one:
 *
 *  1. is an invoice for the period that is about to start still *open*?
 *     `OPEN_INVOICE_STATUSES`, so a half-paid renewal counts as unpaid and
 *     buys no month — that Abo goes `past_due` and dunning takes it from
 *     there;
 *  2. and failing that, does anything say the period was dealt with at all
 *     — a `subscription_invoice` link for it, or the event the zero case
 *     records when there was nothing to charge?
 *
 * The second question is the one that cannot be left out. `issueRenewals`
 * reports a customer whose group threw and lets the run go on (`note(…,
 * "renewal", …)`), so "no open invoice" also describes a period that was
 * **never invoiced at all** — and rolling that one over moves
 * `next_billing_at` past it for good. The following night bills the period
 * after it, the skipped month is never asked for and nothing misses it: one
 * line in one night's report is the only trace. So a period nothing
 * accounts for stands still and is reported, which leaves `next_billing_at`
 * where the next pass will raise the renewal that was owed.
 */
export async function advancePeriods(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now } = context;

    const over = await db
        .select()
        .from(schema.subscription)
        .where(
            and(
                inArray(schema.subscription.status, [
                    "trialing",
                    "active",
                    "past_due",
                ]),
                eq(schema.subscription.cancelAtPeriodEnd, false),
                isNotNull(schema.subscription.currentPeriodEnd),
                lte(schema.subscription.currentPeriodEnd, now),
                scopedTo(context, schema.subscription.customerId),
            ),
        )
        .orderBy(asc(schema.subscription.id));

    for (const candidate of over) {
        try {
            await db.transaction(async (tx) => {
                const row = await lockSubscription(tx, candidate.id);

                if (
                    !row.currentPeriodEnd ||
                    row.currentPeriodEnd.getTime() > now.getTime() ||
                    row.cancelAtPeriodEnd
                ) {
                    return;
                }

                const periodStart = row.currentPeriodEnd;

                const [open] = await tx
                    .select({ id: schema.invoice.id })
                    .from(schema.subscriptionInvoice)
                    .innerJoin(
                        schema.invoice,
                        eq(
                            schema.subscriptionInvoice.invoiceId,
                            schema.invoice.id,
                        ),
                    )
                    .where(
                        and(
                            eq(
                                schema.subscriptionInvoice.subscriptionId,
                                row.id,
                            ),
                            eq(
                                schema.subscriptionInvoice.periodStart,
                                periodStart,
                            ),
                            inArray(schema.invoice.status, [
                                ...OPEN_INVOICE_STATUSES,
                            ]),
                        ),
                    )
                    .limit(1);

                if (open) {
                    const moved = await transitionSubscriptionIn(tx, {
                        subscriptionId: row.id,
                        to: "past_due",
                        summary:
                            "Der Zeitraum ist abgelaufen und die Verlängerung ist noch nicht bezahlt.",
                        actor: context.actor,
                        at: now,
                        data: { invoiceId: open.id },
                    });

                    if (moved.changed) {
                        report.subscriptionsPastDue += 1;
                    }

                    return;
                }

                if (!(await periodWasDealtWith(tx, row.id, periodStart))) {
                    /**
                     * Nothing open, and nothing that says why. Standing
                     * still is the safe answer: `next_billing_at` goes on
                     * pointing at this period, so the next pass raises the
                     * renewal that was missed and the month is billed a day
                     * late rather than not at all.
                     *
                     * Reported, because the alternative is an Abo that is
                     * retried in silence for ever. The run's report is where
                     * the Jobs page looks.
                     */
                    note(
                        report,
                        "period",
                        row.id,
                        `Für den Zeitraum ab ${berlinDay(periodStart)} wurde nichts berechnet — er läuft erst weiter, wenn die Verlängerung erhoben ist.`,
                    );

                    return;
                }

                const period = periodAfter({
                    start: periodStart,
                    cycle: row.cycle,
                    trialEndsAt: row.trialEndsAt,
                    anchorDay: context.settings.policy.billingAnchorDay,
                });

                await tx
                    .update(schema.subscription)
                    .set({
                        currentPeriodStart: periodStart,
                        currentPeriodEnd: period.end,
                        nextBillingAt: period.end,
                        trialEndsAt: null,
                        updatedAt: now,
                    })
                    .where(eq(schema.subscription.id, row.id));

                await recordEvent(tx, {
                    subscriptionId: row.id,
                    kind: "period",
                    summary: "Neuer Abrechnungszeitraum begonnen.",
                    data: {
                        periodStart: periodStart.toISOString(),
                        periodEnd: period.end?.toISOString() ?? null,
                    },
                    actor: context.actor,
                    at: now,
                });

                /**
                 * And only now does a change agreed for the end of the last
                 * period take effect. The renewal invoice already billed
                 * it, a fortnight ago; the item and its services waited for
                 * the day the customer stopped paying for the old one.
                 */
                await applyDueChangesIn(tx, {
                    subscriptionId: row.id,
                    customerId: row.customerId,
                    periodStart,
                    at: now,
                    actor: context.actor,
                });

                if (row.status !== "active") {
                    await transitionSubscriptionIn(tx, {
                        subscriptionId: row.id,
                        to: "active",
                        summary: "Verlängerung bezahlt — wieder aktiv.",
                        actor: context.actor,
                        at: now,
                    });
                }

                report.periodsAdvanced += 1;
            });
        } catch (error) {
            note(report, "period", candidate.id, error);
        }
    }
}

/**
 * Whether anything positively says this period has been dealt with.
 *
 * Two records can say it, and they are the only two ways a period gets past
 * step 2 legitimately:
 *
 *  - a `subscription_invoice` row for it — the claim `issueRenewals` takes
 *    *before* it bills, so the row is there whether that invoice has since
 *    been paid, credited away or cancelled;
 *  - the `invoiced: false` event the zero case writes when the renewal came
 *    to 0,00 € and no document was issued on purpose.
 *
 * Neither of them present means no pass ever got as far as billing this
 * period — which is a different thing from owing nothing for it, and the
 * difference is one month's revenue.
 */
async function periodWasDealtWith(
    tx: Tx,
    subscriptionId: string,
    periodStart: Date,
): Promise<boolean> {
    const [billed] = await tx
        .select({ id: schema.subscriptionInvoice.id })
        .from(schema.subscriptionInvoice)
        .where(
            and(
                eq(schema.subscriptionInvoice.subscriptionId, subscriptionId),
                eq(schema.subscriptionInvoice.periodStart, periodStart),
            ),
        )
        .limit(1);

    if (billed) {
        return true;
    }

    const [free] = await tx
        .select({ id: schema.subscriptionEvent.id })
        .from(schema.subscriptionEvent)
        .where(
            and(
                eq(schema.subscriptionEvent.subscriptionId, subscriptionId),
                eq(schema.subscriptionEvent.kind, "period"),
                /**
                 * Compared as the strings they were written as. Both sides
                 * are the same instant: the event was written from
                 * `next_billing_at` and this is `current_period_end`, which
                 * the run keeps equal to it — so no timezone arithmetic
                 * stands between the two.
                 */
                sql`${schema.subscriptionEvent.data} ->> 'periodStart' = ${periodStart.toISOString()}`,
                sql`${schema.subscriptionEvent.data} ->> 'invoiced' = 'false'`,
            ),
        )
        .limit(1);

    return Boolean(free);
}

// ---------------------------------------------------------------------------
// 5 — dunning
// ---------------------------------------------------------------------------

/**
 * Every invoice that *is* a Mahngebühr.
 *
 * `dunning_action.fee_invoice_id` is written by the same transaction that
 * raises the fee, so an invoice is marked as one from the instant it exists
 * — there is no window in which the next pass could mistake it for an
 * ordinary document. It stays marked for ever: waiving the fee writes
 * `fee_waived_at` and leaves the reference alone.
 */
function isDunningFee(db: Db) {
    return db
        .select({ one: sql`1` })
        .from(schema.dunningAction)
        .where(eq(schema.dunningAction.feeInvoiceId, schema.invoice.id));
}

export async function runDunning(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now, settings } = context;

    /**
     * The open, overdue invoices — **except the Mahngebühren themselves**.
     *
     * A fee invoice is an ordinary finalized invoice of the same customer,
     * due a fortnight after it was raised, so it matches this predicate
     * exactly like the invoice it belongs to. Left in, the run chases it: a
     * reminder at +3, a Mahnung at +10, and that Mahnung raises *another*
     * Mahngebühr, whose Mahnung raises a third. The unique index on
     * `dunning_action (invoice_id, level)` cannot stop it, because every
     * generation is a new invoice id and so a fresh key space — a year of
     * nightly runs at 5,00 € a rung is around 150,00 € of gapless-numbered
     * invoices nobody authorised, and the chains outlive the Abo they came
     * from.
     *
     * The fee stays a document of its own (rule 3: the invoice it belongs
     * to cannot grow a line). It is still owed, still collected, still
     * settled and still withdrawn by a Rechnungskorrektur. It is only never
     * itself the *subject* of a ladder: the invoice it belongs to already
     * carries one, and that ladder ends in a suspension and a termination.
     * A fee invoice is linked to no subscription anyway, so its own rungs
     * could suspend and terminate nothing — they would only tell the
     * customer that services were cut over a Mahngebühr that cancels none.
     */
    const overdue = await db
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            customerId: schema.invoice.customerId,
            dueAt: schema.invoice.dueAt,
            grossCents: schema.invoice.grossCents,
            creditedCents: schema.invoice.creditedCents,
            paidCents: schema.invoice.paidCents,
            buyerEmail: schema.invoice.buyerEmail,
        })
        .from(schema.invoice)
        .where(
            and(
                inArray(schema.invoice.status, [...OPEN_INVOICE_STATUSES]),
                isNotNull(schema.invoice.dueAt),
                lte(schema.invoice.dueAt, now),
                notExists(isDunningFee(db)),
                scopedTo(context, schema.invoice.customerId),
            ),
        )
        .orderBy(asc(schema.invoice.id));

    for (const invoice of overdue) {
        if (!invoice.dueAt || !invoice.number) {
            continue;
        }

        const outstanding = subtract(
            Math.max(
                subtract(invoice.grossCents ?? 0, invoice.creditedCents),
                0,
            ),
            invoice.paidCents,
        );

        if (outstanding <= 0) {
            continue;
        }

        for (const rung of dunningDue(invoice.dueAt, now, settings.billing)) {
            try {
                const acted = await actOnDunningRung(db, context, {
                    invoice: {
                        id: invoice.id,
                        number: invoice.number,
                        customerId: invoice.customerId,
                        dueAt: invoice.dueAt,
                        outstandingCents: outstanding,
                        buyerEmail: invoice.buyerEmail,
                    },
                    level: rung.level,
                    rungDueAt: rung.at,
                });

                if (!acted) {
                    continue;
                }

                report.dunningActions += 1;
                report.servicesSuspended += acted.servicesSuspended;
                report.subscriptionsEnded += acted.subscriptionsEnded;

                if (acted.to) {
                    const email =
                        invoice.buyerEmail ??
                        (await contactEmail(db, invoice.customerId));

                    if (email) {
                        const notified = await sendDunningNotice({
                            to: email,
                            level: rung.level,
                            invoiceId: invoice.id,
                            invoiceNumber: invoice.number,
                            amountCents: outstanding,
                            dueAt: invoice.dueAt,
                            feeCents: acted.feeCents || undefined,
                        });

                        await db
                            .update(schema.dunningAction)
                            .set({
                                notified: notified ? email : "nicht zustellbar",
                                updatedAt: new Date(),
                            })
                            .where(eq(schema.dunningAction.id, acted.id));
                    }
                }

                if (acted.feeInvoiceId) {
                    await renderDocument(
                        db,
                        acted.feeInvoiceId,
                        context.renderPdf ?? true,
                    );
                }
            } catch (error) {
                note(report, `dunning:${rung.level}`, invoice.id, error);
            }
        }
    }
}

type DunningOutcome = {
    id: string;
    /** Whether the customer should be told. */
    to: boolean;
    feeCents: number;
    feeInvoiceId: string | null;
    servicesSuspended: number;
    subscriptionsEnded: number;
};

/**
 * One rung, claimed and acted on inside one transaction.
 *
 * The claim is the `on conflict do nothing` insert into `dunning_action`.
 * Only the writer that got the row does anything, so a customer is written
 * to once, suspended once and terminated once, however often the run sees
 * the invoice still open.
 */
async function actOnDunningRung(
    db: Db,
    context: BillingRunContext,
    input: {
        invoice: {
            id: string;
            number: string;
            customerId: string;
            dueAt: Date;
            outstandingCents: number;
            buyerEmail: string | null;
        };
        level: "reminder" | "mahnung" | "suspend" | "terminate";
        rungDueAt: Date;
    },
): Promise<DunningOutcome | null> {
    const { now, settings } = context;

    return db.transaction(async (tx) => {
        // The invoice is locked first: a payment landing at the same instant
        // must not be able to settle it between this read and the suspension
        // that follows from it.
        const [invoice] = await tx
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, input.invoice.id))
            .for("update");

        if (!invoice || !isOpenInvoice(invoice.status)) {
            return null;
        }

        const outstanding = subtract(
            Math.max(
                subtract(invoice.grossCents ?? 0, invoice.creditedCents),
                0,
            ),
            invoice.paidCents,
        );

        if (outstanding <= 0) {
            return null;
        }

        const id = createId("dunningaction");

        const [claimed] = await tx
            .insert(schema.dunningAction)
            .values({
                id,
                invoiceId: invoice.id,
                customerId: invoice.customerId,
                level: input.level,
                dueAt: input.rungDueAt,
                actedAt: now,
            })
            .onConflictDoNothing()
            .returning({ id: schema.dunningAction.id });

        if (!claimed) {
            return null;
        }

        const links = await tx
            .select({
                subscriptionId: schema.subscriptionInvoice.subscriptionId,
            })
            .from(schema.subscriptionInvoice)
            .where(eq(schema.subscriptionInvoice.invoiceId, invoice.id));

        let servicesSuspended = 0;
        let subscriptionsEnded = 0;
        let feeCents = 0;
        let feeInvoiceId: string | null = null;

        for (const link of links) {
            const row = await lockSubscription(tx, link.subscriptionId);

            if (row.status === "ended") {
                continue;
            }

            if (input.level === "reminder" || input.level === "mahnung") {
                await markOverdue(tx, context, {
                    row,
                    invoiceNumber: invoice.number,
                    level: input.level,
                });

                continue;
            }

            if (input.level === "suspend") {
                /**
                 * The Abo stays `past_due` — it is not paused, and it is not
                 * over — and the services stop. That is why this rung moves
                 * them itself instead of letting a status change do it:
                 * `past_due` deliberately leaves a service running, because
                 * the grace between the due date and this rung is exactly
                 * the point of dunning.
                 */
                await markOverdue(tx, context, {
                    row,
                    invoiceNumber: invoice.number,
                    level: input.level,
                });

                servicesSuspended += await applyServiceFollow(
                    tx,
                    row.id,
                    "suspended",
                    now,
                );

                await recordEvent(tx, {
                    subscriptionId: row.id,
                    kind: "dunning",
                    summary: `Leistungen gesperrt — Rechnung ${invoice.number} ist seit ${settings.billing.dunningSuspendDays} Tagen offen.`,
                    data: { invoiceId: invoice.id },
                    actor: context.actor,
                    at: now,
                });

                continue;
            }

            // terminate
            const ended = await transitionSubscriptionIn(tx, {
                subscriptionId: row.id,
                to: "ended",
                summary: `Beendet — Rechnung ${invoice.number} ist seit ${settings.billing.dunningTerminateDays} Tagen offen.`,
                actor: context.actor,
                at: now,
                data: { invoiceId: invoice.id },
            });

            if (ended.changed) {
                subscriptionsEnded += 1;
            }
        }

        if (input.level === "mahnung" && settings.billing.dunningFeeCents > 0) {
            const raised = await raiseDunningFee(tx, context, {
                invoice,
                feeCents: settings.billing.dunningFeeCents,
            });

            feeCents = raised.feeCents;
            feeInvoiceId = raised.invoiceId;

            await tx
                .update(schema.dunningAction)
                .set({ feeCents, feeInvoiceId, updatedAt: now })
                .where(eq(schema.dunningAction.id, id));
        }

        await audit(tx, {
            actor: context.actor,
            action: "billing.dunning",
            entityType: "invoice",
            entityId: invoice.id,
            after: {
                level: input.level,
                number: invoice.number,
                outstandingCents: outstanding,
                servicesSuspended,
                subscriptionsEnded,
                feeCents,
            },
        });

        return {
            id,
            to: true,
            feeCents,
            feeInvoiceId,
            servicesSuspended,
            subscriptionsEnded,
        };
    });
}

/**
 * Moves a subscription to `past_due` — but only one that may go there.
 *
 * A subscription the customer has already **cancelled** is the case this
 * exists for. `cancelled → past_due` is not a legal move: the Abo is running
 * out its last paid period and reinstating it later must not quietly undo
 * the cancellation. Dunning used to attempt it anyway, which threw inside
 * the rung's transaction — so the `dunning_action` row was rolled back with
 * it, the customer was never chased for the last invoice, the services were
 * never suspended, and the run reported a failure every single night for
 * ever. The same holds for a `paused` Abo with an old invoice still open.
 *
 * The dunning itself is unaffected. The notice still goes out, the services
 * still stop at +14 and the Abo still ends at +30 — `cancelled → ended` and
 * `paused → ended` are both legal. Only the status *label* is left alone,
 * because `cancelled` already says something truer about that Abo than
 * `past_due` would.
 */
async function markOverdue(
    tx: Tx,
    context: BillingRunContext,
    input: {
        row: Subscription;
        invoiceNumber: string | null;
        level: DunningLevel;
    },
) {
    if (input.row.status === "past_due") {
        // Already said, on an earlier rung.
        return;
    }

    if (!canTransition(input.row.status, "past_due")) {
        await recordEvent(tx, {
            subscriptionId: input.row.id,
            kind: "dunning",
            summary: `${DUNNING_LABEL[input.level]} zu Rechnung ${input.invoiceNumber}; der Status „${input.row.status}“ bleibt.`,
            data: { level: input.level, status: input.row.status },
            actor: context.actor,
            at: context.now,
        });

        return;
    }

    await transitionSubscriptionIn(tx, {
        subscriptionId: input.row.id,
        to: "past_due",
        summary: `Rechnung ${input.invoiceNumber} ist überfällig.`,
        actor: context.actor,
        at: context.now,
        data: { level: input.level },
    });
}

/**
 * A Mahngebühr is an invoice of its own.
 *
 * It cannot be a line on the invoice it belongs to: rule 3 says a finalized
 * document does not change, and the trigger in migration 0017 refuses it
 * outright. So the fee is its own small document, pointing at the one it
 * belongs to in its intro text — and `waiveDunningFee()` takes it back with
 * a Rechnungskorrektur, which is the mirror of raising it through the same
 * machinery rather than a second one.
 */
async function raiseDunningFee(
    tx: Tx,
    context: BillingRunContext,
    input: {
        invoice: { id: string; number: string | null; customerId: string };
        feeCents: number;
    },
): Promise<{ invoiceId: string | null; feeCents: number }> {
    const { now, settings } = context;
    const finalizeOptions = {
        at: now,
        settings,
        termDays: settings.policy.paymentTermDays,
        dueAt: null,
    };

    const draft = await createInvoiceDraftIn(
        tx,
        {
            customerId: input.invoice.customerId,
            introText: `Mahngebühr zu Rechnung ${input.invoice.number}.`,
            items: [
                {
                    description: `Mahngebühr zu Rechnung ${input.invoice.number}`,
                    detail: "§ 286 Abs. 1 BGB",
                    quantity: 1,
                    unitCode: "C62",
                    unitPriceCents: input.feeCents,
                },
            ],
        },
        context.actor,
    );

    const finalized = await finalizeInvoiceIn(
        tx,
        draft.id,
        context.actor,
        finalizeOptions,
    );

    return { invoiceId: draft.id, feeCents: finalized.totals.grossCents };
}

// ---------------------------------------------------------------------------
// 6 — cancellations and coupons
// ---------------------------------------------------------------------------

/** `cancel_at_period_end`, honoured on the day the period runs out. */
export async function closePeriodEndCancellations(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now } = context;

    const due = await db
        .select()
        .from(schema.subscription)
        .where(
            and(
                eq(schema.subscription.cancelAtPeriodEnd, true),
                inArray(schema.subscription.status, [
                    "trialing",
                    "active",
                    "past_due",
                    "paused",
                    "cancelled",
                ]),
                or(
                    isNull(schema.subscription.currentPeriodEnd),
                    lte(schema.subscription.currentPeriodEnd, now),
                ),
                scopedTo(context, schema.subscription.customerId),
            ),
        )
        .orderBy(asc(schema.subscription.id));

    for (const candidate of due) {
        try {
            await db.transaction(async (tx) => {
                const row = await lockSubscription(tx, candidate.id);

                if (!row.cancelAtPeriodEnd || row.status === "ended") {
                    return;
                }

                if (
                    row.currentPeriodEnd &&
                    row.currentPeriodEnd.getTime() > now.getTime()
                ) {
                    return;
                }

                const ended = await transitionSubscriptionIn(tx, {
                    subscriptionId: row.id,
                    to: "ended",
                    summary: "Zum Ende des Zeitraums gekündigt — beendet.",
                    actor: context.actor,
                    at: now,
                });

                if (ended.changed) {
                    report.subscriptionsEnded += 1;
                }
            });
        } catch (error) {
            note(report, "cancellation", candidate.id, error);
        }
    }
}

/**
 * A coupon that has run out stops being the Abo's coupon.
 *
 * It changes no price — `renewalCoupon()` already refuses a spent or expired
 * one, so the renewal was at the full price before this ran. What it does is
 * make the row say what is true, so the customer's own page does not go on
 * promising a discount that no longer applies.
 */
export async function expireCoupons(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now } = context;

    const carrying = await db
        .select({
            id: schema.subscription.id,
            couponCode: schema.subscription.couponCode,
            remaining: schema.subscription.discountPeriodsRemaining,
            validUntil: schema.coupon.validUntil,
        })
        .from(schema.subscription)
        .innerJoin(
            schema.coupon,
            eq(schema.subscription.couponId, schema.coupon.id),
        )
        .where(
            and(
                inArray(schema.subscription.status, [...BILLABLE_STATUSES]),
                scopedTo(context, schema.subscription.customerId),
            ),
        )
        .orderBy(asc(schema.subscription.id));

    for (const row of carrying) {
        const spent = row.remaining === 0;
        const expired = Boolean(row.validUntil && now > row.validUntil);

        if (!spent && !expired) {
            continue;
        }

        try {
            await db.transaction(async (tx) => {
                await tx
                    .update(schema.subscription)
                    .set({
                        couponId: null,
                        couponCode: null,
                        discountPeriodsRemaining: 0,
                        updatedAt: now,
                    })
                    .where(eq(schema.subscription.id, row.id));

                await recordEvent(tx, {
                    subscriptionId: row.id,
                    kind: "note",
                    summary:
                        `Gutschein ${row.couponCode ?? ""} ist ausgelaufen; ab jetzt gilt der reguläre Preis.`.trim(),
                    data: { spent, expired },
                    actor: context.actor,
                    at: now,
                });
            });

            report.couponsExpired += 1;
        } catch (error) {
            note(report, "coupon", row.id, error);
        }
    }
}

// ---------------------------------------------------------------------------
// 7 — the mirror of dunning
// ---------------------------------------------------------------------------

/**
 * Everything that owes nothing any more comes back.
 *
 * `emitInvoicePaid` already does this the moment money lands, which is what
 * a customer who pays at midnight notices. This is the catch-up for the
 * cases that seam cannot cover: a mail that threw, a process that died
 * between the payment and the reactivation, an invoice credited away by hand.
 *
 * Two kinds of candidate, because dunning leaves two kinds of mark. A
 * `past_due` label is the obvious one. The other is a **suspended service
 * under an Abo that is not `past_due` at all**: the +14 rung stops the
 * services itself and leaves the label alone wherever `past_due` would be a
 * lie, so a gekündigtes Abo is suspended while it still says `cancelled`.
 * Looking only at the label here left exactly those servers switched off for
 * the rest of a period the customer had just paid for. `wakeSettledIn` then
 * asks what is owed rather than what the row is called.
 */
export async function reactivateSettled(
    db: Db,
    context: BillingRunContext,
    report: BillingRunReport,
) {
    const { now } = context;

    const suspendedService = db
        .select({ one: sql`1` })
        .from(schema.service)
        .innerJoin(
            schema.subscriptionItem,
            eq(schema.service.subscriptionItemId, schema.subscriptionItem.id),
        )
        .where(
            and(
                eq(
                    schema.subscriptionItem.subscriptionId,
                    schema.subscription.id,
                ),
                eq(schema.service.status, "suspended"),
            ),
        );

    const stuck = await db
        .select({ id: schema.subscription.id })
        .from(schema.subscription)
        .where(
            and(
                // `paused` and `ended` are left out on purpose: their
                // services are down because the status says so, not because
                // dunning said so, and no payment lifts that.
                inArray(schema.subscription.status, [
                    "trialing",
                    "active",
                    "past_due",
                    "cancelled",
                ]),
                or(
                    eq(schema.subscription.status, "past_due"),
                    exists(suspendedService),
                ),
                scopedTo(context, schema.subscription.customerId),
            ),
        )
        .orderBy(asc(schema.subscription.id));

    for (const candidate of stuck) {
        try {
            const back = await db.transaction(async (tx) =>
                wakeSettledIn(tx, candidate.id, {
                    reason: "Nichts mehr offen",
                    actor: context.actor,
                    at: now,
                }),
            );

            if (back.woken) {
                report.reactivated += 1;
            }
        } catch (error) {
            note(report, "reactivate", candidate.id, error);
        }
    }
}
