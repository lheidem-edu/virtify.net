import { describe, expect, it } from "vitest";
import {
    addBerlinMonths,
    berlinDay,
    berlinDaysBetween,
} from "@/lib/berlin-date";
import {
    firstPeriod,
    followingPeriod,
    isAnchorDay,
    nextAnchor,
    pauseSpanMs,
    periodAfter,
    precedingPeriod,
    proratedUnitPrice,
    shiftInstant,
} from "@/server/billing/periods";

/**
 * Billing periods, in concrete days and concrete cents.
 *
 * Two things are being pinned down here and both have bitten this codebase
 * before: that a calendar day means a **Berlin** day, and that a prorated
 * amount is rounded exactly once, by `src/lib/money.ts`.
 */

describe("adding months on the Berlin calendar", () => {
    it("clamps to the length of the month it lands in", () => {
        // 31 January plus one month is 28 February, not 3 March.
        const from = new Date("2026-01-31T09:00:00.000Z");

        expect(berlinDay(addBerlinMonths(from, 1))).toBe("2026-02-28");
        expect(berlinDay(addBerlinMonths(from, 3))).toBe("2026-04-30");
        expect(berlinDay(addBerlinMonths(from, 12))).toBe("2027-01-31");
    });

    it("clamps into a leap February and out of it again", () => {
        const from = new Date("2028-01-31T09:00:00.000Z");

        expect(berlinDay(addBerlinMonths(from, 1))).toBe("2028-02-29");
        expect(berlinDay(addBerlinMonths(from, 13))).toBe("2029-02-28");
    });

    it("keeps the wall-clock time across a daylight-saving change", () => {
        // 10:00 Berlin in February is 09:00 UTC; in April it is 08:00 UTC.
        // The subscription still renews at 10:00 as the customer reads it.
        const february = new Date("2026-02-15T09:00:00.000Z");
        const april = addBerlinMonths(february, 2);

        expect(april.toISOString()).toBe("2026-04-15T08:00:00.000Z");
        expect(berlinDay(april)).toBe("2026-04-15");
    });

    it("counts the two clock-change days as one day each", () => {
        // 29 March 2026 is 23 hours long, 25 October is 25. Counting
        // elapsed milliseconds would make the first 0 days and the second 1.
        expect(
            berlinDaysBetween(
                new Date("2026-03-28T23:00:00.000Z"),
                new Date("2026-03-29T22:00:00.000Z"),
            ),
        ).toBe(1);

        expect(
            berlinDaysBetween(
                new Date("2026-10-24T22:00:00.000Z"),
                new Date("2026-10-25T23:00:00.000Z"),
            ),
        ).toBe(1);
    });
});

describe("the billing anchor", () => {
    it("accepts 1 to 28 and nothing else", () => {
        expect(isAnchorDay(1)).toBe(true);
        expect(isAnchorDay(28)).toBe(true);
        // 29, 30 and 31 do not exist in every month, so a subscription
        // anchored to one would be billed on a day that moves.
        expect(isAnchorDay(29)).toBe(false);
        expect(isAnchorDay(0)).toBe(false);
        expect(isAnchorDay(1.5)).toBe(false);
    });

    it("is the next occurrence, strictly after the instant given", () => {
        const at = new Date("2026-11-07T14:30:00.000Z");

        expect(berlinDay(nextAnchor(at, 1))).toBe("2026-12-01");
        expect(berlinDay(nextAnchor(at, 15))).toBe("2026-11-15");
        // The 7th at 14:30 is past the 7th at 00:00, so the next one is
        // December's — a zero-day first period would be a free period.
        expect(berlinDay(nextAnchor(at, 7))).toBe("2026-12-07");
    });

    it("rolls into the next year from December", () => {
        expect(
            berlinDay(nextAnchor(new Date("2026-12-20T10:00:00.000Z"), 5)),
        ).toBe("2027-01-05");
    });

    it("starts the anchored day at midnight Berlin, not midnight UTC", () => {
        // 1 December is CET, so 00:00 Berlin is 23:00 UTC on 30 November.
        expect(
            nextAnchor(new Date("2026-11-07T14:30:00.000Z"), 1).toISOString(),
        ).toBe("2026-11-30T23:00:00.000Z");
    });
});

describe("the first period", () => {
    it("is a whole period when nothing is anchored", () => {
        const period = firstPeriod({
            start: new Date("2026-11-07T10:00:00.000Z"),
            cycle: "monthly",
            anchorDay: 0,
        });

        expect(berlinDay(period.end as Date)).toBe("2026-12-07");
        expect(period.prorated).toBe(false);
        expect(period.usedDays).toBe(30);
        expect(period.periodDays).toBe(30);
    });

    it("ends at the anchor and says how much of a period that is", () => {
        // 7 November to 1 December is 24 days; a full month from the 7th
        // would have been 30.
        const period = firstPeriod({
            start: new Date("2026-11-07T10:00:00.000Z"),
            cycle: "monthly",
            anchorDay: 1,
        });

        expect(berlinDay(period.end as Date)).toBe("2026-12-01");
        expect(period.usedDays).toBe(24);
        expect(period.periodDays).toBe(30);
        expect(period.prorated).toBe(true);
    });

    it("is not prorated when the start already sits on the anchor", () => {
        const period = firstPeriod({
            // 00:00 Berlin on 1 November.
            start: new Date("2026-10-31T23:00:00.000Z"),
            cycle: "monthly",
            anchorDay: 1,
        });

        expect(berlinDay(period.end as Date)).toBe("2026-12-01");
        expect(period.prorated).toBe(false);
        expect(period.usedDays).toBe(30);
    });

    it("charges a single day when the order lands the day before", () => {
        const period = firstPeriod({
            start: new Date("2026-11-30T10:00:00.000Z"),
            cycle: "monthly",
            anchorDay: 1,
        });

        expect(period.usedDays).toBe(1);
        // 30 November plus a month is 30 December, so the full period the
        // single day is measured against is 30 days, not December's 31.
        expect(period.periodDays).toBe(30);
        // 19,99 € for 1 of 30 days: 1999 / 30 = 66,63… → 67 ct.
        expect(proratedUnitPrice(1999, period)).toBe(67);
    });

    it("has no period at all for a one-off sale", () => {
        const period = firstPeriod({
            start: new Date("2026-11-07T10:00:00.000Z"),
            cycle: "onetime",
            anchorDay: 1,
        });

        expect(period.end).toBeNull();
        expect(period.prorated).toBe(false);
        expect(proratedUnitPrice(4999, period)).toBe(4999);
    });

    it("prorates an annual price over the days to the anchor", () => {
        const period = firstPeriod({
            start: new Date("2026-11-07T10:00:00.000Z"),
            cycle: "annual",
            anchorDay: 1,
        });

        expect(berlinDay(period.end as Date)).toBe("2026-12-01");
        expect(period.usedDays).toBe(24);
        expect(period.periodDays).toBe(365);
        // 199,90 € × 24/365 = 1314,24… → 13,14 €.
        expect(proratedUnitPrice(19_990, period)).toBe(1314);
    });
});

describe("prorating", () => {
    it("leaves a whole period alone", () => {
        const period = firstPeriod({
            start: new Date("2026-11-07T10:00:00.000Z"),
            cycle: "monthly",
            anchorDay: 0,
        });

        expect(proratedUnitPrice(1999, period)).toBe(1999);
    });

    it("rounds half away from zero, once", () => {
        const period = firstPeriod({
            // 15 of 30 days: exactly half.
            start: new Date("2026-11-16T10:00:00.000Z"),
            cycle: "monthly",
            anchorDay: 1,
        });

        expect(period.usedDays).toBe(15);
        expect(period.periodDays).toBe(30);
        // 19,99 € ÷ 2 = 9,995 € — half a cent, which rounds up to 10,00 €.
        expect(proratedUnitPrice(1999, period)).toBe(1000);
        // And a discount line, which is negative, rounds away from zero too,
        // so a discounted period stays the exact complement of its gross.
        expect(proratedUnitPrice(-1999, period)).toBe(-1000);
    });
});

describe("every period after the first", () => {
    it("is whole, and starts where the last one ended", () => {
        const first = firstPeriod({
            start: new Date("2026-11-07T10:00:00.000Z"),
            cycle: "quarterly",
            anchorDay: 1,
        });

        const second = followingPeriod(first.end as Date, "quarterly");

        expect(berlinDay(second.start)).toBe("2026-12-01");
        expect(berlinDay(second.end as Date)).toBe("2027-03-01");
        expect(second.prorated).toBe(false);
        expect(proratedUnitPrice(5699, second)).toBe(5699);
    });
});

describe("the period before one — rolling a renewal back", () => {
    it("is the exact inverse of going forward", () => {
        // The round trip has to be exact, or a cancelled renewal leaves the
        // subscription a day away from where it started.
        for (const cycle of [
            "monthly",
            "quarterly",
            "semiannual",
            "annual",
            "biennial",
        ] as const) {
            const start = new Date("2026-02-01T00:00:00.000+01:00");
            const forward = followingPeriod(start, cycle);
            const back = precedingPeriod(forward.end as Date, cycle);

            expect(back.start.getTime(), cycle).toBe(start.getTime());
            expect((back.end as Date).getTime(), cycle).toBe(
                (forward.end as Date).getTime(),
            );
            expect(back.periodDays, cycle).toBe(forward.periodDays);
        }
    });

    it("names the days it covers, in Berlin", () => {
        const back = precedingPeriod(
            new Date("2026-03-01T00:00:00.000+01:00"),
            "monthly",
        );

        expect(berlinDay(back.start)).toBe("2026-02-01");
        expect(berlinDay(back.end as Date)).toBe("2026-03-01");
        expect(back.periodDays).toBe(28);
        expect(back.prorated).toBe(false);
    });

    it("has nothing to roll back for a one-off sale", () => {
        const back = precedingPeriod(new Date("2026-03-01"), "onetime");

        expect(back.end).toBeNull();
        expect(back.periodDays).toBe(0);
    });
});

describe("pausing and resuming", () => {
    it("gives back exactly the span that stood still", () => {
        const paused = new Date("2026-11-10T12:00:00.000Z");
        const resumed = new Date("2026-11-20T12:00:00.000Z");
        const span = pauseSpanMs(paused, resumed);

        expect(span).toBe(10 * 86_400_000);

        const end = new Date("2026-12-01T00:00:00.000Z");

        expect(shiftInstant(end, span)?.toISOString()).toBe(
            "2026-12-11T00:00:00.000Z",
        );
    });

    it("never shortens a period somebody has paid for", () => {
        // A resume stamped before its own pause — only a repaired row can
        // produce it, and it must not take days away.
        expect(
            pauseSpanMs(
                new Date("2026-11-20T00:00:00.000Z"),
                new Date("2026-11-10T00:00:00.000Z"),
            ),
        ).toBe(0);
    });

    it("leaves a one-off's absent end absent", () => {
        expect(shiftInstant(null, 86_400_000)).toBeNull();
    });
});

describe("the period a subscription moves into next", () => {
    it("is a whole cycle from where the last one ended", () => {
        const next = periodAfter({
            start: new Date("2026-12-01T00:00:00.000+01:00"),
            cycle: "monthly",
            trialEndsAt: null,
            anchorDay: 1,
        });

        expect(berlinDay(next.end as Date)).toBe("2027-01-01");
        expect(next.prorated).toBe(false);
    });

    it("cuts the first paid period back to the anchor when a trial just ended", () => {
        // The trial ended on the 15th; with the anchor on the 1st the first
        // paid period runs 15.11. – 1.12. and is charged for those 16 days.
        const trialEnd = new Date("2026-11-15T09:00:00.000+01:00");
        const next = periodAfter({
            start: trialEnd,
            cycle: "monthly",
            trialEndsAt: trialEnd,
            anchorDay: 1,
        });

        expect(berlinDay(next.end as Date)).toBe("2026-12-01");
        expect(next.prorated).toBe(true);
        expect(next.usedDays).toBe(16);
        expect(next.periodDays).toBe(30);
    });

    it("gives a whole period after a trial when no anchor is configured", () => {
        const trialEnd = new Date("2026-11-15T09:00:00.000+01:00");
        const next = periodAfter({
            start: trialEnd,
            cycle: "monthly",
            trialEndsAt: trialEnd,
            anchorDay: 0,
        });

        expect(berlinDay(next.end as Date)).toBe("2026-12-15");
        expect(next.prorated).toBe(false);
    });

    it("stops cutting once the trial is behind it", () => {
        // `trial_ends_at` is still on the row but no longer the period that
        // is starting: every period from here is a whole one.
        const next = periodAfter({
            start: new Date("2026-12-01T00:00:00.000+01:00"),
            cycle: "monthly",
            trialEndsAt: new Date("2026-11-15T09:00:00.000+01:00"),
            anchorDay: 1,
        });

        expect(berlinDay(next.end as Date)).toBe("2027-01-01");
        expect(next.prorated).toBe(false);
    });
});
