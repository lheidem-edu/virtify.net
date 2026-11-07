import { describe, expect, it } from "vitest";
import { berlinInstant, berlinOffset, berlinYear } from "@/lib/berlin-date";

/**
 * Everything is stored in UTC; everything the operator types is a Berlin day.
 * These are the two places that gap has already produced a bug — a coupon
 * refused for the day it was meant to cover, and a tax switch that would have
 * started an hour early and caught the evening before.
 */
describe("the Berlin calendar", () => {
    it("knows when the clocks change", () => {
        expect(berlinOffset("2027-01-01")).toBe("+01:00");
        expect(berlinOffset("2027-07-01")).toBe("+02:00");
        // The changeover days themselves: 28.03.2027 and 31.10.2027.
        expect(berlinOffset("2027-03-27")).toBe("+01:00");
        expect(berlinOffset("2027-10-31")).toBe("+01:00");
    });

    it("starts a winter day at 23:00 UTC the day before", () => {
        expect(berlinInstant("2027-01-01")?.toISOString()).toBe(
            "2026-12-31T23:00:00.000Z",
        );
        expect(berlinInstant("2027-01-01", true)?.toISOString()).toBe(
            "2027-01-01T22:59:59.999Z",
        );
    });

    it("starts a summer day at 22:00 UTC the day before", () => {
        expect(berlinInstant("2027-07-01")?.toISOString()).toBe(
            "2027-06-30T22:00:00.000Z",
        );
    });

    /**
     * The two days a year the offset at noon is not the offset at midnight.
     * Sampling noon and applying it to 00:00 put the spring-forward day's
     * start at 23:00 the evening before — a tax switch taking effect on the
     * invoices of the day it was not scheduled for, which is the exact
     * failure this module's docstring says it exists to prevent.
     */
    describe("on the two days the clocks move", () => {
        const berlin = new Intl.DateTimeFormat("de-DE", {
            timeZone: "Europe/Berlin",
            dateStyle: "short",
            timeStyle: "medium",
        });

        it("still starts the spring-forward day at midnight", () => {
            // Last Sunday of March: noon is CEST, 00:00 is still CET.
            expect(berlinInstant("2026-03-29")?.toISOString()).toBe(
                "2026-03-28T23:00:00.000Z",
            );
            expect(berlin.format(berlinInstant("2026-03-29") as Date)).toBe(
                "29.03.26, 00:00:00",
            );
            expect(berlin.format(berlinInstant("2027-03-28") as Date)).toBe(
                "28.03.27, 00:00:00",
            );
        });

        it("still starts the fall-back day at midnight", () => {
            // Last Sunday of October: noon is CET, 00:00 is still CEST.
            expect(berlinInstant("2026-10-25")?.toISOString()).toBe(
                "2026-10-24T22:00:00.000Z",
            );
            expect(berlin.format(berlinInstant("2026-10-25") as Date)).toBe(
                "25.10.26, 00:00:00",
            );
            expect(berlin.format(berlinInstant("2027-10-31") as Date)).toBe(
                "31.10.27, 00:00:00",
            );
        });

        it("ends both of them a millisecond before midnight", () => {
            for (const day of ["2026-03-29", "2026-10-25", "2027-03-28"]) {
                expect(berlin.format(berlinInstant(day, true) as Date)).toBe(
                    `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(2, 4)}, 23:59:59`,
                );
            }
        });

        it("covers the whole day and not a minute more", () => {
            for (const day of [
                "2026-03-29",
                "2026-10-25",
                "2026-06-15",
                "2026-01-15",
            ]) {
                const start = berlinInstant(day) as Date;
                const end = berlinInstant(day, true) as Date;
                const hours = (end.getTime() + 1 - start.getTime()) / 3_600_000;

                // 23 on the short day, 25 on the long one, 24 otherwise.
                expect([23, 24, 25]).toContain(hours);
                expect(berlin.format(start).slice(0, 8)).toBe(
                    berlin.format(end).slice(0, 8),
                );
            }
        });
    });

    it("gives up on anything that is not a date", () => {
        expect(berlinInstant("")).toBeNull();
        expect(berlinInstant("heute")).toBeNull();
        expect(berlinInstant("2027-13-45")).toBeNull();
    });

    it("reads a year in Berlin, not in UTC", () => {
        // 31.12. at 23:30 UTC is already the new year in Berlin.
        expect(berlinYear(new Date("2026-12-31T23:30:00Z"))).toBe(2027);
        expect(berlinYear(new Date("2026-12-31T22:30:00Z"))).toBe(2026);
        expect(berlinYear(new Date("2026-06-15T12:00:00Z"))).toBe(2026);
    });
});
