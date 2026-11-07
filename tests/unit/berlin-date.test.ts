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
