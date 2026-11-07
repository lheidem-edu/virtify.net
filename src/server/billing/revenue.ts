import "server-only";
import { sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { berlinYear } from "@/lib/berlin-date";
import { subtract } from "@/lib/money";
import type { RevenueBasis, Settings } from "@/server/settings";

/**
 * The § 19 UStG threshold monitor.
 *
 * The Kleinunternehmerregelung applies while the previous calendar year's
 * Gesamtumsatz stayed under the first limit *and* the current year stays
 * under the second. Since 2025 the second one is hard: the moment it is
 * exceeded the scheme ends, from that transaction on — so an operator who
 * finds out in February that they passed it in November has been issuing the
 * wrong invoices for months. Hence a monitor that warns at 80 % rather than a
 * report somebody has to remember to run.
 *
 * Revenue here is **net, from paid invoices, less what credit notes took
 * back**, attributed to a calendar year by the date the settings name.
 */

type Db = typeof defaultDb;
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Which instant a document counts at, as SQL.
 *
 * The timestamps are stored without a zone and hold UTC (see the note in
 * `_columns.ts`), so they are labelled UTC and then read in the operator's
 * own calendar — an invoice paid at 00:30 on 1 January in Berlin belongs to
 * the new year, and at 23:30 on 31 December to the old one.
 */
function yearOf(column: unknown, fallback: unknown) {
    return sql`extract(year from (coalesce(${column}, ${fallback}) at time zone 'UTC') at time zone 'Europe/Berlin')`;
}

function invoiceBasis(basis: RevenueBasis) {
    switch (basis) {
        case "invoice":
            return yearOf(schema.invoice.issuedAt, schema.invoice.issuedAt);
        case "payment":
            return yearOf(schema.invoice.paidAt, schema.invoice.issuedAt);
        default:
            return yearOf(
                schema.invoice.servicePeriodStart,
                schema.invoice.issuedAt,
            );
    }
}

function creditNoteBasis(basis: RevenueBasis) {
    switch (basis) {
        case "invoice":
        case "payment":
            // A refund has no date of its own until Phase 5 books one, so a
            // correction counts when it was issued.
            return yearOf(
                schema.creditNote.issuedAt,
                schema.creditNote.issuedAt,
            );
        default:
            return yearOf(
                schema.creditNote.servicePeriodStart,
                schema.creditNote.issuedAt,
            );
    }
}

/**
 * Net revenue of one calendar year.
 *
 * Only paid invoices count — § 19 measures what was taken in, not what was
 * billed — and only credit notes against invoices that were paid are
 * subtracted, because a correction to an invoice nobody paid takes back
 * revenue that was never counted.
 */
export async function netRevenueForYear(
    executor: Executor,
    year: number,
    basis: RevenueBasis,
): Promise<number> {
    const [earned] = await executor
        .select({
            cents: sql<number>`coalesce(sum(${schema.invoice.netCents}), 0)::int`,
        })
        .from(schema.invoice)
        .where(
            sql`${schema.invoice.status} in ('paid', 'cancelled')
                and ${schema.invoice.paidAt} is not null
                and ${invoiceBasis(basis)} = ${year}`,
        );

    const [credited] = await executor
        .select({
            cents: sql<number>`coalesce(sum(${schema.creditNote.netCents}), 0)::int`,
        })
        .from(schema.creditNote)
        .innerJoin(
            schema.invoice,
            sql`${schema.invoice.id} = ${schema.creditNote.invoiceId}`,
        )
        .where(
            sql`${schema.invoice.paidAt} is not null
                and ${creditNoteBasis(basis)} = ${year}`,
        );

    return subtract(earned?.cents ?? 0, credited?.cents ?? 0);
}

export type ThresholdMetric = {
    /** `previous` or `current` — which of the two § 19 limits this is. */
    metric: "previous" | "current";
    year: number;
    netCents: number;
    limitCents: number;
    /** Share of the limit, 0–… — 0.8 is the first warning. */
    ratio: number;
    /** 80, 100, or null while neither has been reached. */
    level: 80 | 100 | null;
};

export type ThresholdStatus = {
    previous: ThresholdMetric;
    current: ThresholdMetric;
    /** True while the scheme still applies on both counts. */
    stillSmallBusiness: boolean;
    /** The highest warning either figure has reached. */
    level: 80 | 100 | null;
};

function metric(
    name: "previous" | "current",
    year: number,
    netCents: number,
    limitCents: number,
): ThresholdMetric {
    const ratio = limitCents > 0 ? netCents / limitCents : 0;

    return {
        metric: name,
        year,
        netCents,
        limitCents,
        ratio,
        level: ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : null,
    };
}

export async function thresholdStatus(
    executor: Executor,
    settings: Settings,
    at = new Date(),
): Promise<ThresholdStatus> {
    const year = berlinYear(at);
    const basis = settings.revenue.basis;

    const [previousNet, currentNet] = await Promise.all([
        netRevenueForYear(executor, year - 1, basis),
        netRevenueForYear(executor, year, basis),
    ]);

    const previous = metric(
        "previous",
        year - 1,
        previousNet,
        settings.revenue.kleinunternehmerPreviousLimitCents,
    );
    const current = metric(
        "current",
        year,
        currentNet,
        settings.revenue.kleinunternehmerCurrentLimitCents,
    );

    const levels = [previous.level, current.level].filter(
        (value): value is 80 | 100 => value !== null,
    );

    return {
        previous,
        current,
        stillSmallBusiness: previous.ratio < 1 && current.ratio < 1,
        level: levels.includes(100) ? 100 : levels.includes(80) ? 80 : null,
    };
}

/**
 * Claims the right to send one warning. The unique index on
 * (year, metric, level) is what makes this idempotent: the insert either
 * wins or conflicts, and only the winner sends a mail. A second invoice
 * finalized the same afternoon finds the row already there.
 */
export async function claimThresholdNotice(
    executor: Executor,
    entry: ThresholdMetric & { level: 80 | 100 },
): Promise<boolean> {
    const rows = await executor
        .insert(schema.revenueNotice)
        .values({
            year: entry.year,
            metric: entry.metric,
            level: entry.level,
            netCents: entry.netCents,
            limitCents: entry.limitCents,
        })
        .onConflictDoNothing()
        .returning({ id: schema.revenueNotice.id });

    return rows.length > 0;
}
