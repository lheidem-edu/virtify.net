import { type BillingCycle, CYCLE_MONTHS } from "@/db/schema/catalog";
import {
    addBerlinMonths,
    berlinDaysBetween,
    berlinParts,
    daysInMonth,
    fromBerlinParts,
} from "@/lib/berlin-date";
import { prorate } from "@/lib/money";

/**
 * When a billing period starts, when it ends, and what a short first one
 * costs.
 *
 * Pure: it takes instants and a setting and returns instants and integers.
 * No database, no clock it was not handed. Everything is reckoned on the
 * **Berlin** calendar, because a billing day is a day the operator and the
 * customer both point at on a wall — reading UTC parts to get one is how
 * Phase 3 shipped an invoice whose XML disagreed with its own PDF.
 */

/** The smallest anchor day; 1 is the first of the month. */
export const MIN_ANCHOR_DAY = 1;
/**
 * The largest. Not 31, and not 29 or 30 either: a day that does not exist in
 * February is a billing day that silently moves, and a billing day that
 * moves is one nobody can reconcile a bank statement against.
 */
export const MAX_ANCHOR_DAY = 28;

export function isAnchorDay(value: number): boolean {
    return (
        Number.isSafeInteger(value) &&
        value >= MIN_ANCHOR_DAY &&
        value <= MAX_ANCHOR_DAY
    );
}

export type BillingPeriod = {
    start: Date;
    /** Exclusive — the instant the next period begins. Null for a one-off. */
    end: Date | null;
    /** Days of a full period this one actually covers. */
    usedDays: number;
    /** Days a full period of this cycle would have covered. */
    periodDays: number;
    /** Whether it was cut short to reach the billing anchor. */
    prorated: boolean;
};

/** How many months one period of a cycle runs; null for a one-off sale. */
export function cycleMonths(cycle: BillingCycle): number | null {
    return CYCLE_MONTHS[cycle];
}

/**
 * The next time the anchor day comes round, at 00:00 Berlin, strictly after
 * `after`. Strictly, so a subscription that starts exactly on the anchor
 * gets a whole period rather than a zero-day one.
 */
export function nextAnchor(after: Date, anchorDay: number): Date {
    if (!isAnchorDay(anchorDay)) {
        throw new Error(`Not a billing anchor day: ${anchorDay}`);
    }

    const parts = berlinParts(after);
    const midnight = {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
    };

    let candidate = fromBerlinParts({
        ...midnight,
        year: parts.year,
        month: parts.month,
        day: Math.min(anchorDay, daysInMonth(parts.year, parts.month)),
    });

    if (candidate.getTime() > after.getTime()) {
        return candidate;
    }

    const zeroBased = parts.month; // already the next month, zero-based
    const year = parts.year + Math.floor(zeroBased / 12);
    const month = (zeroBased % 12) + 1;

    candidate = fromBerlinParts({
        ...midnight,
        year,
        month,
        day: Math.min(anchorDay, daysInMonth(year, month)),
    });

    return candidate;
}

/**
 * The period that starts at `start`.
 *
 * With no anchor it is a whole period of the cycle. With one it ends at the
 * next anchor instead, which makes it short, and `usedDays / periodDays` is
 * what the recurring lines are charged at.
 *
 * The alignment applies to every cycle, annual included: an annual product
 * ordered on the 2nd with the anchor on the 1st is charged for the days up
 * to the 1st and then runs year to year from there. That is what "align to
 * a billing day" says, and the alternative — aligning only short cycles —
 * is a rule with no principle behind it. Open to being overruled.
 *
 * No minimum length either: ordering on the 31st with the anchor on the 1st
 * buys one day. Charging a day's worth and then a full period is honest
 * arithmetic, and rolling the stub into the next period would mean charging
 * for a month that has not been agreed.
 */
export function firstPeriod(input: {
    start: Date;
    cycle: BillingCycle;
    /** 1–28, or 0 to bill on the day of the order. */
    anchorDay: number;
}): BillingPeriod {
    const months = cycleMonths(input.cycle);

    if (months === null) {
        // A one-off sale has no period to be inside of.
        return {
            start: input.start,
            end: null,
            usedDays: 0,
            periodDays: 0,
            prorated: false,
        };
    }

    const full = addBerlinMonths(input.start, months);
    const periodDays = berlinDaysBetween(input.start, full);

    if (!isAnchorDay(input.anchorDay)) {
        return {
            start: input.start,
            end: full,
            usedDays: periodDays,
            periodDays,
            prorated: false,
        };
    }

    const anchored = nextAnchor(input.start, input.anchorDay);
    const end = anchored.getTime() < full.getTime() ? anchored : full;
    const usedDays = berlinDaysBetween(input.start, end);

    return {
        start: input.start,
        end,
        usedDays,
        periodDays,
        prorated: end.getTime() !== full.getTime(),
    };
}

/** Every period after the first: a whole one, from where the last ended. */
export function followingPeriod(
    start: Date,
    cycle: BillingCycle,
): BillingPeriod {
    const months = cycleMonths(cycle);

    if (months === null) {
        return {
            start,
            end: null,
            usedDays: 0,
            periodDays: 0,
            prorated: false,
        };
    }

    const end = addBerlinMonths(start, months);
    const days = berlinDaysBetween(start, end);

    return { start, end, usedDays: days, periodDays: days, prorated: false };
}

/**
 * What a recurring amount costs over a short period. Rounded once, half away
 * from zero, by `src/lib/money.ts` — never by a float left lying around.
 *
 * Applied to the **unit price** rather than to a line's total, so the line
 * still reads "2 × 9,67 €" and its own multiplication still adds up. A
 * prorated line that had to collapse to a quantity of one would stop saying
 * how many of the thing was bought.
 */
export function proratedUnitPrice(
    unitPriceCents: number,
    period: BillingPeriod,
): number {
    if (!period.prorated || period.periodDays <= 0) {
        return unitPriceCents;
    }

    return prorate(unitPriceCents, period.usedDays, period.periodDays);
}
