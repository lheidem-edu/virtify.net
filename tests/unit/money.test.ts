import { describe, expect, it } from "vitest";
import {
    add,
    allocate,
    basisPoints,
    format,
    multiply,
    negate,
    parseAmount,
    percent,
    prorate,
    roundHalfUp,
    split,
    subtract,
    toDecimalString,
} from "@/lib/money";

describe("rounding", () => {
    it("rounds a half away from zero in both directions", () => {
        expect(roundHalfUp(0.5)).toBe(1);
        expect(roundHalfUp(1.5)).toBe(2);
        expect(roundHalfUp(2.5)).toBe(3);
        expect(roundHalfUp(-0.5)).toBe(-1);
        expect(roundHalfUp(-1.5)).toBe(-2);
        expect(roundHalfUp(0.4999)).toBe(0);
    });

    it("makes a correction the exact negation of what it reverses", () => {
        // The property a Rechnungskorrektur depends on. Math.round breaks it:
        // Math.round(-0.5) is -0, so the reversal would be a cent short.
        for (const value of [0.5, 1.5, 2.5, 12.345, 1999.005, 0.05]) {
            expect(roundHalfUp(-value)).toBe(-roundHalfUp(value));
        }
    });
});

describe("arithmetic", () => {
    it("adds and subtracts whole cents", () => {
        expect(add(1999, 500, 1)).toBe(2500);
        expect(subtract(2500, 1999, 500)).toBe(1);
        expect(add()).toBe(0);
    });

    it("refuses a fractional cent instead of silently rounding it", () => {
        expect(() => add(10.5)).toThrow(/integer number of cents/);
        expect(() => negate(0.1)).toThrow(/integer number of cents/);
        expect(() => multiply(0.5, 2)).toThrow(/integer number of cents/);
    });

    it("multiplies a price by a quantity", () => {
        expect(multiply(1999, 12)).toBe(23_988);
        expect(multiply(1999, 0)).toBe(0);
        expect(multiply(1999, -1)).toBe(-1999);
        // 7.5 months of 19.99 € is 149.925 € → 149.93 €, not 149.92 €.
        expect(multiply(1999, 7.5)).toBe(14_993);
    });

    it("takes a percentage", () => {
        expect(percent(1000, 19)).toBe(190);
        expect(percent(1999, 19)).toBe(380); // 379.81 → 380
        expect(percent(1999, 0)).toBe(0);
        expect(percent(-1999, 19)).toBe(-380);

        // Exactly half a cent has to go up. `cents * (rate / 100)` got these
        // wrong: 29 / 100 is 0.28999999999999998, so 217,5 arrived as
        // 217,49999999999997 and Math.round took it down.
        expect(percent(750, 29)).toBe(218); // 217,50
        expect(percent(330, 35)).toBe(116); // 115,50
        expect(percent(165, 70)).toBe(116); // 115,50
        expect(percent(50, 29)).toBe(15); // 14,50
    });

    it("takes a rate in basis points, exactly", () => {
        expect(basisPoints(1000, 1900)).toBe(190);
        expect(basisPoints(1999, 1550)).toBe(310); // 309,845
        expect(basisPoints(750, 2900)).toBe(218); // 217,50
        expect(basisPoints(-750, 2900)).toBe(-218);
        expect(basisPoints(1999, 0)).toBe(0);
        expect(() => basisPoints(1999, 19.5)).toThrow(/basis points/);

        // No whole-percent rate on any amount up to 100,00 € disagrees with
        // exact arithmetic. Before, 228 pairs under 50,00 € did.
        const wrong: string[] = [];

        for (let rate = 1; rate <= 100; rate += 1) {
            for (let cents = 1; cents <= 10_000; cents += 1) {
                const exact = Math.round((cents * rate) / 100 + Number.EPSILON);
                const half = (cents * rate) % 100 === 50;

                if (
                    basisPoints(cents, rate * 100) !==
                    (half ? Math.ceil((cents * rate) / 100) : exact)
                ) {
                    wrong.push(`${rate}% of ${cents}`);
                }
            }
        }

        expect(wrong).toEqual([]);
    });
});

describe("allocate", () => {
    it("keeps the parts summing to the whole", () => {
        expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
        expect(allocate(1000, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(1000);
        expect(allocate(5, [1, 1, 1, 1, 1, 1])).toEqual([1, 1, 1, 1, 1, 0]);
    });

    it("hands leftover cents to the largest remainders", () => {
        // 100 cents over weights 1:2:4 → 14.28, 28.57, 57.14
        expect(allocate(100, [1, 2, 4])).toEqual([14, 29, 57]);
        expect(allocate(100, [1, 2, 4]).reduce((a, b) => a + b, 0)).toBe(100);
    });

    it("mirrors a negative amount exactly", () => {
        expect(allocate(-1000, [1, 1, 1])).toEqual([-334, -333, -333]);
        expect(allocate(-100, [1, 2, 4])).toEqual([-14, -29, -57]);
    });

    it("shares out evenly when every weight is zero", () => {
        expect(allocate(10, [0, 0, 0, 0])).toEqual([3, 3, 2, 2]);
    });

    it("splits into a fixed number of parts", () => {
        expect(split(1999, 4)).toEqual([500, 500, 500, 499]);
        expect(split(1999, 1)).toEqual([1999]);
        expect(() => split(100, 0)).toThrow();
    });

    it("rejects impossible weights", () => {
        expect(() => allocate(100, [])).toThrow(/no weights/);
        expect(() => allocate(100, [1, -1])).toThrow(/non-negative/);
    });
});

describe("prorate", () => {
    it("charges only the days that were used", () => {
        expect(prorate(3000, 15, 30)).toBe(1500);
        expect(prorate(1999, 1, 30)).toBe(67); // 66.63 → 67
        expect(prorate(1999, 30, 30)).toBe(1999);
        expect(prorate(1999, 0, 30)).toBe(0);
    });

    it("clamps a period it cannot exceed", () => {
        expect(prorate(1999, 40, 30)).toBe(1999);
        expect(prorate(1999, -5, 30)).toBe(0);
        expect(() => prorate(1999, 1, 0)).toThrow(/billing period/);
    });
});

describe("formatting", () => {
    it("formats German currency", () => {
        // Intl uses a narrow no-break space before the symbol.
        expect(format(199_900).replace(/ /g, " ")).toBe("1.999,00 €");
        expect(format(0).replace(/ /g, " ")).toBe("0,00 €");
        expect(format(-1999).replace(/ /g, " ")).toBe("-19,99 €");
    });

    it("writes a bare decimal for XML and CSV", () => {
        expect(toDecimalString(199_900)).toBe("1999.00");
        expect(toDecimalString(5)).toBe("0.05");
        expect(toDecimalString(0)).toBe("0.00");
        expect(toDecimalString(-1999)).toBe("-19.99");
    });
});

describe("parseAmount", () => {
    it("accepts what a person actually types", () => {
        expect(parseAmount("19,99")).toBe(1999);
        expect(parseAmount("19.99")).toBe(1999);
        expect(parseAmount("1.999,00")).toBe(199_900);
        expect(parseAmount("1,999.00")).toBe(199_900);
        expect(parseAmount("19,99 €")).toBe(1999);
        expect(parseAmount(" 1 999,00 ")).toBe(199_900);
        expect(parseAmount("19")).toBe(1900);
        expect(parseAmount("-19,99")).toBe(-1999);
        expect(parseAmount("(19,99)")).toBe(-1999);
        expect(parseAmount("19,999")).toBe(2000); // 19.999 → 20.00
        expect(parseAmount("+19,99")).toBe(1999);
    });

    it("reads an ambiguous number the German way", () => {
        // A lone comma is the decimal separator, a lone dot before three
        // digits groups thousands. German is the product's language.
        expect(parseAmount("1,000")).toBe(100);
        expect(parseAmount("1,00")).toBe(100);
        expect(parseAmount("1.000")).toBe(100_000);
        expect(parseAmount("1.234.567,89")).toBe(123_456_789);
        expect(parseAmount("1,234,567.89")).toBe(123_456_789);
    });

    it("rejects a separator that does not group three digits", () => {
        expect(parseAmount("1.999.00")).toBeNull();
        expect(parseAmount("1.23.456")).toBeNull();
        expect(parseAmount("1234.567,89")).toBeNull();
    });

    it("returns null rather than billing zero for nonsense", () => {
        expect(parseAmount("")).toBeNull();
        expect(parseAmount("   ")).toBeNull();
        expect(parseAmount("abc")).toBeNull();
        expect(parseAmount("1,2,3")).toBeNull();
        expect(parseAmount(".")).toBeNull();
        expect(parseAmount("19,99,")).toBeNull();
    });
});
