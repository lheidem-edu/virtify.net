import { describe, expect, it } from "vitest";
import {
    calculateProration,
    remainingDaysOf,
} from "@/server/billing/proration";

/**
 * Proration, in cents.
 *
 * The build plan asks for "upgrade mid-cycle proration with concrete cents",
 * so every case here states the figure it expects rather than a shape. The
 * arithmetic is pure, which is exactly why it can be stated that way.
 */

describe("what a plan change costs for the rest of the period", () => {
    it("charges the difference for the days that are left — 19,99 → 39,99 at half a month", () => {
        // 30-day month, 15 days used, 15 left.
        //   unused credit: 1999 × 15/30 = 999,5 → 1000 (half away from zero)
        //   new charge:    3999 × 15/30 = 1999,5 → 2000
        //   difference:                            1000
        const result = calculateProration({
            currentPeriodGrossCents: 1999,
            nextPeriodGrossCents: 3999,
            remainingDays: 15,
            periodDays: 30,
        });

        expect(result.unusedCreditCents).toBe(1000);
        expect(result.newChargeCents).toBe(2000);
        expect(result.differenceCents).toBe(1000);
        expect(result.direction).toBe("upgrade");
        expect(result.owedByCustomerCents).toBe(1000);
        expect(result.owedToCustomerCents).toBe(0);
    });

    it("gives the same figure back on the way down — 39,99 → 19,99 at half a month", () => {
        const result = calculateProration({
            currentPeriodGrossCents: 3999,
            nextPeriodGrossCents: 1999,
            remainingDays: 15,
            periodDays: 30,
        });

        expect(result.unusedCreditCents).toBe(2000);
        expect(result.newChargeCents).toBe(1000);
        expect(result.differenceCents).toBe(-1000);
        expect(result.direction).toBe("downgrade");
        // The mirror: what the upgrade invoiced is what the downgrade credits.
        expect(result.owedToCustomerCents).toBe(1000);
        expect(result.owedByCustomerCents).toBe(0);
    });

    it("is exactly symmetrical: the two directions differ only in sign", () => {
        const up = calculateProration({
            currentPeriodGrossCents: 1234,
            nextPeriodGrossCents: 8765,
            remainingDays: 11,
            periodDays: 31,
        });
        const down = calculateProration({
            currentPeriodGrossCents: 8765,
            nextPeriodGrossCents: 1234,
            remainingDays: 11,
            periodDays: 31,
        });

        expect(down.differenceCents).toBe(-up.differenceCents);
        expect(down.owedToCustomerCents).toBe(up.owedByCustomerCents);
        expect(up.owedToCustomerCents).toBe(down.owedByCustomerCents);
    });

    it("comes out at zero when the price does not move — both sides round the same way", () => {
        // 1999 × 7/30 = 466,43… Taken as one prorate on each side, the two
        // roundings are identical and cancel. Prorating a difference instead
        // would be the same answer here but not for every pair.
        const result = calculateProration({
            currentPeriodGrossCents: 1999,
            nextPeriodGrossCents: 1999,
            remainingDays: 7,
            periodDays: 30,
        });

        expect(result.differenceCents).toBe(0);
        expect(result.direction).toBe("none");
        expect(result.unusedCreditCents).toBe(result.newChargeCents);
    });

    it("charges a whole period when the change happens on day one", () => {
        const result = calculateProration({
            currentPeriodGrossCents: 1000,
            nextPeriodGrossCents: 2500,
            remainingDays: 30,
            periodDays: 30,
        });

        expect(result.unusedCreditCents).toBe(1000);
        expect(result.newChargeCents).toBe(2500);
        expect(result.differenceCents).toBe(1500);
    });

    it("charges nothing when the period has run out", () => {
        const result = calculateProration({
            currentPeriodGrossCents: 1999,
            nextPeriodGrossCents: 9999,
            remainingDays: 0,
            periodDays: 30,
        });

        expect(result.differenceCents).toBe(0);
        expect(result.newChargeCents).toBe(0);
        expect(result.unusedCreditCents).toBe(0);
    });

    it("charges nothing for a cycle that has no period — a one-off sale", () => {
        const result = calculateProration({
            currentPeriodGrossCents: 5000,
            nextPeriodGrossCents: 9000,
            remainingDays: 0,
            periodDays: 0,
        });

        expect(result.differenceCents).toBe(0);
    });

    it("clamps days that make no sense rather than inventing money", () => {
        // More days left than the period has: a clock that went backwards,
        // or a period that was shortened. Charging 40/30 of a month would
        // bill for days nobody agreed to.
        const over = calculateProration({
            currentPeriodGrossCents: 1000,
            nextPeriodGrossCents: 2000,
            remainingDays: 40,
            periodDays: 30,
        });

        expect(over.remainingDays).toBe(30);
        expect(over.newChargeCents).toBe(2000);

        const under = calculateProration({
            currentPeriodGrossCents: 1000,
            nextPeriodGrossCents: 2000,
            remainingDays: -5,
            periodDays: 30,
        });

        expect(under.remainingDays).toBe(0);
        expect(under.differenceCents).toBe(0);
    });

    it("refuses anything that is not whole cents", () => {
        expect(() =>
            calculateProration({
                currentPeriodGrossCents: 19.99,
                nextPeriodGrossCents: 2000,
                remainingDays: 15,
                periodDays: 30,
            }),
        ).toThrow(/whole number/);
    });

    it("prorates an annual plan over its own days, not over a month", () => {
        // 199,90 €/Jahr, 100 of 365 days left:
        //   19990 × 100/365 = 5476,7… → 5477
        const result = calculateProration({
            currentPeriodGrossCents: 19_990,
            nextPeriodGrossCents: 0,
            remainingDays: 100,
            periodDays: 365,
        });

        expect(result.unusedCreditCents).toBe(5477);
        expect(result.differenceCents).toBe(-5477);
    });
});

describe("how much of a period is left", () => {
    const start = new Date("2026-11-01T00:00:00.000+01:00");
    const end = new Date("2026-12-01T00:00:00.000+01:00");

    it("counts whole Berlin days, with the day of the change still to come", () => {
        // 30-day period; on the 16th, 15 days have elapsed.
        const span = remainingDaysOf({
            at: new Date("2026-11-16T09:00:00.000+01:00"),
            periodStart: start,
            periodEnd: end,
        });

        expect(span.periodDays).toBe(30);
        expect(span.remainingDays).toBe(15);
    });

    it("gives the whole period on its first day", () => {
        expect(
            remainingDaysOf({
                at: new Date("2026-11-01T08:00:00.000+01:00"),
                periodStart: start,
                periodEnd: end,
            }),
        ).toEqual({ periodDays: 30, remainingDays: 30 });
    });

    it("gives nothing once the period is over", () => {
        expect(
            remainingDaysOf({
                at: new Date("2026-12-05T08:00:00.000+01:00"),
                periodStart: start,
                periodEnd: end,
            }).remainingDays,
        ).toBe(0);
    });

    it("gives nothing for a period with no end", () => {
        expect(
            remainingDaysOf({
                at: new Date("2026-11-16T09:00:00.000+01:00"),
                periodStart: start,
                periodEnd: null,
            }),
        ).toEqual({ periodDays: 0, remainingDays: 0 });
    });
});
