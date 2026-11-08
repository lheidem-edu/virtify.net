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
        /**
         * Whether the customer is actually being charged for less than a
         * period — in days, which is what the price is computed from, not in
         * instants. An order placed on the anchor day itself at any time
         * other than midnight ends a few hours short of a whole month but
         * still covers all 30 of its days, and stamping that line "anteilig
         * für 30 von 30 Tagen" at the full price on an immutable invoice is
         * a sentence nobody can make sense of.
         */
        prorated: usedDays < periodDays,
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
 * The period a subscription moves into next.
 *
 * One function, two callers, and that is the whole reason it exists: the
 * renewal run has to *bill* exactly the period the run then *advances*
 * into, and computing "the next period" in two places is how an invoice
 * ends up covering sixteen days while the subscription moves on by thirty.
 *
 * Almost always a whole cycle from where the last one ended. The exception
 * is the first paid period after a trial: the trial ended on whatever day it
 * happened to end on, so with a billing anchor configured that period is cut
 * short to reach it — exactly as the checkout cuts the first period of an
 * Abo that was never on trial. `trial_ends_at` is what says which case this
 * is, and it is still set at this point because only this step clears it.
 */
export function periodAfter(input: {
    start: Date;
    cycle: BillingCycle;
    trialEndsAt: Date | null;
    /** 1–28, or 0 to bill on the day the period starts. */
    anchorDay: number;
}): BillingPeriod {
    const leavingTrial =
        input.trialEndsAt !== null &&
        input.trialEndsAt.getTime() === input.start.getTime();

    return leavingTrial
        ? firstPeriod({
              start: input.start,
              cycle: input.cycle,
              anchorDay: input.anchorDay,
          })
        : followingPeriod(input.start, input.cycle);
}

/**
 * The period *before* one that starts at `start` — `followingPeriod` read
 * backwards.
 *
 * It exists for one reason: rolling a period back. A renewal invoice that is
 * cancelled has to put the subscription where it was, and computing "one
 * cycle earlier" a second way is how a rolled-back period ends up a day
 * away from the one it rolled back from. `addBerlinMonths` is its own
 * inverse on the Berlin calendar for every anchor day this panel allows
 * (1–28, see MAX_ANCHOR_DAY), so the round trip is exact.
 */
export function precedingPeriod(
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

    const began = addBerlinMonths(start, -months);
    const days = berlinDaysBetween(began, start);

    return {
        start: began,
        end: start,
        usedDays: days,
        periodDays: days,
        prorated: false,
    };
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

/**
 * How long a subscription stood still. Pause and resume are the same span
 * read in two directions, so it is one function: the period end moves
 * forward by exactly what the customer could not use, and never by a figure
 * computed a second way.
 *
 * Negative spans are clamped to zero. A clock that went backwards — a resume
 * stamped before its own pause, which only a repaired row can produce —
 * must not shorten a period somebody has paid for.
 */
export function pauseSpanMs(pausedAt: Date, resumedAt: Date): number {
    return Math.max(resumedAt.getTime() - pausedAt.getTime(), 0);
}

/** The same instant, moved by a span. Null stays null — a one-off has no end. */
export function shiftInstant(at: Date | null, byMs: number): Date | null {
    return at === null ? null : new Date(at.getTime() + byMs);
}
