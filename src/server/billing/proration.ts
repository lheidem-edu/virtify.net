import type { BillingCycle } from "@/db/schema/catalog";
import { berlinDaysBetween } from "@/lib/berlin-date";
import { prorate, subtract } from "@/lib/money";
import { followingPeriod } from "./periods";

/**
 * What a plan change costs for the rest of the period it happens in.
 *
 * Pure — integer cents and instants in, integer cents out. No database, no
 * clock it was not handed, no catalog. The prices it is given come from
 * `calculateQuote()`; what happens to them here is one `prorate()` per side
 * and one subtraction, so there is no second arithmetic that could disagree
 * with the figure the customer agreed to.
 *
 * **One function, both directions.** An upgrade and a downgrade are the same
 * sentence — *give back the unused part of what was bought, charge the
 * unused part of what is now wanted* — and the only thing that differs is
 * the sign of the difference. Writing them as two functions is how a panel
 * ends up charging for an upgrade and forgetting to credit a downgrade; the
 * caller books `differenceCents` and reads its sign.
 *
 * Both sides are prorated over the **same** days, by the same call, so the
 * two roundings cannot drift apart: a change that swaps a plan for an
 * identically priced one comes out at exactly 0, not at ±1 cent.
 */

export type ProrationInput = {
    /** What a whole period of the current configuration costs. */
    currentPeriodGrossCents: number;
    /** What a whole period of the new configuration costs. */
    nextPeriodGrossCents: number;
    /** Days of the period that are still to come, including today. */
    remainingDays: number;
    /** Days a whole period of this cycle covers. */
    periodDays: number;
};

export type Proration = {
    /** The unused part of what was already paid for. Never negative. */
    unusedCreditCents: number;
    /** The same days at the new price. Never negative. */
    newChargeCents: number;
    /**
     * What changes hands. Positive is owed by the customer and becomes an
     * invoice; negative is owed to them and becomes credit on the account.
     */
    differenceCents: number;
    direction: "upgrade" | "downgrade" | "none";
    /**
     * The two halves of `differenceCents`, each as a positive figure: what
     * the customer owes becomes an invoice, what we owe becomes credit.
     *
     * Derived here rather than at the two call sites, so the mirror is
     * literally the same expression read the other way round. One of them is
     * always zero.
     */
    owedByCustomerCents: number;
    owedToCustomerCents: number;
    remainingDays: number;
    periodDays: number;
};

/**
 * How much of a period is still ahead, counted in whole Berlin days.
 *
 * Berlin, because a billing day is a day on a wall calendar (see
 * `src/server/billing/periods.ts`), and whole days because that is the unit
 * the period itself is measured in — mixing a day-count denominator with a
 * millisecond numerator is how a one-month change lands a cent away from the
 * one-month price.
 *
 * Clamped to the period: a change requested after the period has run out
 * prorates nothing, which is the honest answer — the next invoice charges
 * the new price in full.
 */
export function remainingDaysOf(input: {
    at: Date;
    periodStart: Date;
    periodEnd: Date | null;
}): { remainingDays: number; periodDays: number } {
    if (!input.periodEnd) {
        return { remainingDays: 0, periodDays: 0 };
    }

    const periodDays = berlinDaysBetween(input.periodStart, input.periodEnd);
    const elapsed = berlinDaysBetween(input.periodStart, input.at);
    const remaining = periodDays - elapsed;

    return {
        periodDays: Math.max(periodDays, 0),
        remainingDays: Math.min(
            Math.max(remaining, 0),
            Math.max(periodDays, 0),
        ),
    };
}

/**
 * The span a plan change may prorate over: the days still ahead, over the
 * days a whole period's price actually buys.
 *
 * Proration shares out **what the customer paid for this period**, and the
 * price it is handed is the price of a whole period — so the denominator has
 * to be a whole period's days, whatever span the subscription row happens to
 * be sitting in. Two spans are not whole periods and both used to be divided
 * as if they were:
 *
 * - **The free days of a trial.** Nothing is invoiced for them (the checkout
 *   drops every recurring line while trialing), so there is nothing to share
 *   out: a downgrade on day 7 of 14 credited 7/14 of a monthly price as real
 *   money the customer had never paid, and an upgrade charged them 7/14 of a
 *   period they were being given. A period nobody paid for prorates nothing,
 *   which `calculateProration` already answers for `periodDays <= 0`.
 * - **A first period cut short to reach the billing anchor.** It was charged
 *   at `usedDays / periodDays` of the whole-period price (see
 *   `proratedUnitPrice`), so the ten days left of a twenty-day stub are worth
 *   10/30 of a month and not 10/20 of one.
 *
 * An ordinary whole period is the case where the two denominators coincide,
 * which is why the defect could sit here unnoticed: `followingPeriod` counts
 * exactly the days `firstPeriod` divided by.
 */
export function prorationSpan(input: {
    at: Date;
    periodStart: Date;
    periodEnd: Date | null;
    /** Set while the free days are still running; cleared when they end. */
    trialEndsAt: Date | null;
    cycle: BillingCycle;
}): { remainingDays: number; periodDays: number } {
    if (input.trialEndsAt && input.at.getTime() < input.trialEndsAt.getTime()) {
        return { remainingDays: 0, periodDays: 0 };
    }

    const span = remainingDaysOf(input);

    if (span.periodDays <= 0) {
        // No period at all — a one-off sale, or a row with no end.
        return span;
    }

    const whole = followingPeriod(input.periodStart, input.cycle).periodDays;

    return {
        remainingDays: span.remainingDays,
        periodDays: whole > 0 ? whole : span.periodDays,
    };
}

export function calculateProration(input: ProrationInput): Proration {
    for (const [name, value] of Object.entries(input)) {
        if (!Number.isSafeInteger(value)) {
            throw new Error(`${name} must be a whole number, got ${value}`);
        }
    }

    const periodDays = Math.max(input.periodDays, 0);
    const remainingDays = Math.min(
        Math.max(input.remainingDays, 0),
        periodDays,
    );

    /**
     * Nothing left of the period — or a cycle with no period at all, which
     * a one-off sale is. Then there is nothing to prorate: the change simply
     * applies from the next period on, and no money moves today.
     */
    const share = (amount: number) =>
        periodDays <= 0 || remainingDays <= 0
            ? 0
            : prorate(amount, remainingDays, periodDays);

    const unusedCreditCents = share(input.currentPeriodGrossCents);
    const newChargeCents = share(input.nextPeriodGrossCents);
    const differenceCents = subtract(newChargeCents, unusedCreditCents);

    return {
        unusedCreditCents,
        newChargeCents,
        differenceCents,
        direction:
            differenceCents > 0
                ? "upgrade"
                : differenceCents < 0
                  ? "downgrade"
                  : "none",
        owedByCustomerCents: Math.max(differenceCents, 0),
        owedToCustomerCents: Math.max(subtract(0, differenceCents), 0),
        remainingDays,
        periodDays,
    };
}
