import { describe, expect, it } from "vitest";
import {
    calculateProration,
    prorationSpan,
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

describe("what a plan change is allowed to prorate over", () => {
    /**
     * Proration shares out what the customer **paid** for this period. The
     * denominator is therefore the days a whole period's price buys, and the
     * numerator the days still ahead — not whatever span the subscription
     * row happens to be sitting in.
     *
     * Two spans are not whole periods: the free days of a trial, which
     * nobody paid for at all, and a short first period, which was charged at
     * `usedDays / periodDays` of the whole-period price.
     */

    /** The 1.11. to the 1.12.: a whole, ordinary, paid month. */
    const start = new Date("2026-11-01T00:00:00.000+01:00");
    const end = new Date("2026-12-01T00:00:00.000+01:00");

    it("prorates nothing while the free days run — ein Testzeitraum ist nicht bezahlt", () => {
        // 14 Testtage ab dem 1.11., am 8.11. sind 7 übrig. Rechnet man die
        // über 7/14 eines ganzen Monatspreises ab, bekommt ein Downgrade im
        // Testzeitraum 39,99 € × 7/14 = 20,00 € zurück und zahlt 19,99 €
        // × 7/14 = 10,00 € — macht 10,00 € Guthaben für einen Zeitraum, für
        // den der Kunde nie etwas bezahlt hat.
        const span = prorationSpan({
            at: new Date("2026-11-08T09:00:00.000+01:00"),
            periodStart: new Date("2026-11-01T09:00:00.000+01:00"),
            periodEnd: new Date("2026-11-15T09:00:00.000+01:00"),
            trialEndsAt: new Date("2026-11-15T09:00:00.000+01:00"),
            cycle: "monthly",
        });

        expect(span).toEqual({ remainingDays: 0, periodDays: 0 });

        const down = calculateProration({
            currentPeriodGrossCents: 3999,
            nextPeriodGrossCents: 1999,
            ...span,
        });

        expect(down.differenceCents).toBe(0);
        expect(down.owedToCustomerCents).toBe(0);
    });

    it("counts a short first period against a whole period's days", () => {
        // Bestellt am 11.11., Abrechnungstag der 1.: der erste Zeitraum
        // läuft 20 Tage und wurde mit 1999 × 20/30 = 1333 berechnet. Am
        // 21.11. sind 10 Tage offen — das sind 10/30 des Monatspreises
        // (666) und nicht 10/20 davon (1000, also mehr, als für diese Tage
        // je bezahlt wurde).
        const span = prorationSpan({
            at: new Date("2026-11-21T09:00:00.000+01:00"),
            periodStart: new Date("2026-11-11T09:00:00.000+01:00"),
            periodEnd: new Date("2026-12-01T00:00:00.000+01:00"),
            trialEndsAt: null,
            cycle: "monthly",
        });

        expect(span).toEqual({ remainingDays: 10, periodDays: 30 });
        expect(
            calculateProration({
                currentPeriodGrossCents: 1999,
                nextPeriodGrossCents: 3999,
                ...span,
            }).unusedCreditCents,
        ).toBe(666);
    });

    it("leaves an ordinary whole period exactly where it was", () => {
        // The case every figure in this file is pinned to: a 30-day month
        // with 15 days left. Nothing above may move it by a cent.
        const span = prorationSpan({
            at: new Date("2026-11-16T09:00:00.000+01:00"),
            periodStart: start,
            periodEnd: end,
            trialEndsAt: null,
            cycle: "monthly",
        });

        expect(span).toEqual({ remainingDays: 15, periodDays: 30 });

        const up = calculateProration({
            currentPeriodGrossCents: 1999,
            nextPeriodGrossCents: 3999,
            ...span,
        });

        expect(up.unusedCreditCents).toBe(1000);
        expect(up.newChargeCents).toBe(2000);
        expect(up.differenceCents).toBe(1000);
    });

    it("prorates an annual Abo over its own year", () => {
        expect(
            prorationSpan({
                at: new Date("2026-11-16T09:00:00.000+01:00"),
                periodStart: start,
                periodEnd: new Date("2027-11-01T00:00:00.000+01:00"),
                trialEndsAt: null,
                cycle: "annual",
            }),
        ).toEqual({ remainingDays: 350, periodDays: 365 });
    });

    it("prorates nothing for a cycle with no period — a one-off sale", () => {
        expect(
            prorationSpan({
                at: new Date("2026-11-16T09:00:00.000+01:00"),
                periodStart: start,
                periodEnd: null,
                trialEndsAt: null,
                cycle: "onetime",
            }),
        ).toEqual({ remainingDays: 0, periodDays: 0 });
    });

    it("prorates again as soon as the free days are behind us", () => {
        // The run has not cleared `trial_ends_at` yet, but the trial window
        // is over and the period that runs now is one the customer pays
        // for: 15.11. bis 15.12., am 20.11. sind 25 von 30 Tagen offen.
        expect(
            prorationSpan({
                at: new Date("2026-11-20T09:00:00.000+01:00"),
                periodStart: new Date("2026-11-15T00:00:00.000+01:00"),
                periodEnd: new Date("2026-12-15T00:00:00.000+01:00"),
                trialEndsAt: new Date("2026-11-15T00:00:00.000+01:00"),
                cycle: "monthly",
            }),
        ).toEqual({ remainingDays: 25, periodDays: 30 });
    });
});
