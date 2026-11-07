import type { BillingCycle } from "@/db/schema/catalog";
import { multiply } from "@/lib/money";
import type { BillingPeriod } from "@/server/billing/periods";
import { proratedUnitPrice } from "@/server/billing/periods";
import type { Quote, QuoteLine } from "@/server/billing/pricing";

/**
 * Turning a quote into the lines of the first invoice.
 *
 * Pure — a quote and a period in, invoice lines out. No database, no clock
 * it was not handed. It is kept apart from `./service.ts` for the same
 * reason `pricing.ts` is kept apart from `quote.ts`: the arithmetic of what
 * is charged should be statable in a test as integers, without a
 * transaction around it.
 *
 * It computes no prices of its own. Every amount comes from the quote; the
 * only thing that happens to one here is proration, and that goes through
 * `src/lib/money.ts` exactly once per line.
 */

/** What a built line adds to the invoice, before the invoice recomputes it. */
export type BuiltLine = {
    description: string;
    detail: string | null;
    quantity: number;
    unitCode: string;
    unitPriceCents: number;
    servicePeriodStart: Date | null;
    servicePeriodEnd: Date | null;
    /**
     * quantity × unit price, by the same `multiply` the invoice's own
     * `calculateTotals` uses — so the order's stored figure and the
     * invoice's are the same arithmetic rather than two that agree today.
     */
    netCents: number;
};

/**
 * UN/ECE Recommendation 20 for the period a recurring line bills. A code the
 * recipient's software recognises is the difference between an e-invoice
 * that imports and one that is rejected.
 */
export const UNIT_CODE: Record<BillingCycle, string> = {
    monthly: "MON",
    quarterly: "QAN",
    semiannual: "SAN",
    annual: "ANN",
    /** There is no two-year code; the service period on the line says it. */
    biennial: "C62",
    onetime: "C62",
};

/** A one-off charge is a piece, not a span of time. */
export const ONE_OFF_UNIT = "C62";

/**
 * The lines one ordered item puts on the first invoice.
 *
 * A trial defers the *period*, not the setup fee — Phase 2's decision, and
 * what every panel this replaces does — so a trialing item contributes only
 * its one-off lines, and an item that is nothing but a trial contributes
 * none at all. When the first period was cut short to reach the billing
 * anchor, the recurring lines are prorated on the **unit price**, so the
 * line still says how many of the thing was bought and its own
 * multiplication still adds up to its net.
 */
export function buildInvoiceLines(
    quote: Quote,
    period: BillingPeriod,
    options: { trialing: boolean },
): BuiltLine[] {
    const lines: BuiltLine[] = [];

    for (const line of quote.lines) {
        if (line.recurring && options.trialing) {
            continue;
        }

        lines.push(
            line.recurring
                ? recurringLine(line, quote.totals.cycle, period)
                : oneOffLine(line),
        );
    }

    return lines;
}

function recurringLine(
    line: QuoteLine,
    cycle: BillingCycle,
    period: BillingPeriod,
): BuiltLine {
    const unitPriceCents = proratedUnitPrice(line.unitAmountCents, period);

    return {
        description: line.label,
        detail: periodDetail(line.detail ?? null, period),
        quantity: line.quantity,
        unitCode: UNIT_CODE[cycle],
        unitPriceCents,
        servicePeriodStart: period.start,
        servicePeriodEnd: period.end,
        netCents: multiply(unitPriceCents, line.quantity),
    };
}

function oneOffLine(line: QuoteLine): BuiltLine {
    return {
        description: line.label,
        detail: line.detail ?? null,
        quantity: line.quantity,
        unitCode: ONE_OFF_UNIT,
        unitPriceCents: line.unitAmountCents,
        servicePeriodStart: null,
        servicePeriodEnd: null,
        netCents: multiply(line.unitAmountCents, line.quantity),
    };
}

const DAY_LABEL = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
});

/**
 * Says on the line that it is a part period, and which one. A prorated
 * amount with nothing to explain it is the commonest reason a first invoice
 * comes back as a question.
 *
 * The end is printed as the last *covered* day: the period's end is
 * exclusive — it is the instant the next one begins — and printing it
 * unchanged would claim a day the customer has not paid for.
 */
export function periodDetail(
    detail: string | null,
    period: BillingPeriod,
): string | null {
    if (!period.prorated || !period.end) {
        return detail;
    }

    const note =
        `anteilig für ${period.usedDays} von ${period.periodDays} Tagen ` +
        `(${DAY_LABEL.format(period.start)} – ${DAY_LABEL.format(
            new Date(period.end.getTime() - 1),
        )})`;

    return detail ? `${detail} · ${note}` : note;
}

/**
 * How many periods *after* this one the coupon still covers. Null means
 * every one; 0 means it is spent.
 *
 * The period the checkout has just billed is deducted here, so Phase 6's
 * renewal can decrement without having to know whether the order was on
 * trial — a trialing subscription has had no period billed yet, so its
 * counter is untouched.
 */
export function remainingDiscountPeriods(
    discountPeriods: number | null,
    billedFirstPeriod: boolean,
): number | null {
    if (discountPeriods === null) {
        return null;
    }

    if (discountPeriods === 0) {
        return 0;
    }

    return Math.max(0, discountPeriods - (billedFirstPeriod ? 1 : 0));
}
