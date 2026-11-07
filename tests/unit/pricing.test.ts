import { describe, expect, it } from "vitest";
import {
    calculateQuote,
    checkCoupon,
    type QuoteCoupon,
    type QuoteInput,
    type QuoteSelection,
} from "@/server/billing/pricing";

/**
 * Billing logic with concrete cents, as CLAUDE.md asks for. Every number in
 * here is written out rather than computed from the inputs — a test that
 * recomputes the thing it is testing agrees with any bug the code has.
 */

const NOW = new Date("2026-11-07T10:00:00.000Z");

/** VPS M: 19,99 € im Monat, 10,00 € Einrichtung. */
function input(overrides: Partial<QuoteInput> = {}): QuoteInput {
    return {
        product: { id: "product_01TESTVPSM", name: "VPS M" },
        pricing: {
            cycle: "monthly",
            currency: "EUR",
            priceCents: 1999,
            setupFeeCents: 1000,
            trialDays: 0,
        },
        now: NOW,
        ...overrides,
    };
}

function coupon(overrides: Partial<QuoteCoupon> = {}): QuoteCoupon {
    return {
        id: "coupon_01TESTCODE",
        code: "WILLKOMMEN",
        kind: "percent",
        percentBasisPoints: 2500,
        amountCents: null,
        currency: null,
        duration: "once",
        durationPeriods: null,
        appliesToSetupFee: false,
        productIds: [],
        cycles: [],
        validFrom: null,
        validUntil: null,
        maxRedemptions: null,
        redemptions: 0,
        active: true,
        ...overrides,
    };
}

/** +8 GB RAM: 5,00 € im Monat. */
const extraRam: QuoteSelection = {
    optionId: "configoption_01RAM",
    optionName: "Arbeitsspeicher",
    valueId: "configoptionvalue_01RAM8",
    valueName: "+8 GB",
    quantity: 1,
    priceCents: 500,
    setupFeeCents: 0,
};

/** Zwei zusätzliche IPv4-Adressen zu je 1,50 €, je 2,00 € Einrichtung. */
const extraIpv4: QuoteSelection = {
    optionId: "configoption_01IPV4",
    optionName: "Zusätzliche IPv4",
    valueId: "configoptionvalue_01IPV4",
    valueName: "Adresse",
    quantity: 2,
    priceCents: 150,
    setupFeeCents: 200,
};

describe("the base price", () => {
    it("is the cell's price for one of the product", () => {
        const { totals } = calculateQuote(input());

        expect(totals.recurringGrossCents).toBe(1999);
        expect(totals.firstPeriodCents).toBe(1999);
        expect(totals.renewalCents).toBe(1999);
        // 19,99 € laufend + 10,00 € Einrichtung.
        expect(totals.dueTodayCents).toBe(2999);
    });

    it("is whatever the chosen cycle says, not a monthly price times twelve", () => {
        const { totals } = calculateQuote(
            input({
                pricing: {
                    cycle: "annual",
                    currency: "EUR",
                    // Two months free against 12 × 19,99 € = 239,88 €.
                    priceCents: 19_990,
                    setupFeeCents: 1000,
                    trialDays: 0,
                },
            }),
        );

        expect(totals.cycle).toBe("annual");
        expect(totals.recurringGrossCents).toBe(19_990);
        expect(totals.dueTodayCents).toBe(20_990);
    });

    it("multiplies by the quantity, setup fee included", () => {
        const { totals } = calculateQuote(input({ quantity: 3 }));

        expect(totals.recurringGrossCents).toBe(5997);
        expect(totals.setupGrossCents).toBe(3000);
        expect(totals.dueTodayCents).toBe(8997);
    });

    it("refuses a quantity that is not a whole number of products", () => {
        expect(() => calculateQuote(input({ quantity: 0 }))).toThrow();
        expect(() => calculateQuote(input({ quantity: 1.5 }))).toThrow();
    });

    it("has nothing to renew when the sale is one-off", () => {
        const { totals } = calculateQuote(
            input({
                pricing: {
                    cycle: "onetime",
                    currency: "EUR",
                    priceCents: 4900,
                    setupFeeCents: 0,
                    // Ignored: there is no first period to defer.
                    trialDays: 30,
                },
            }),
        );

        expect(totals.renewalCents).toBe(0);
        expect(totals.trialDays).toBe(0);
        expect(totals.dueTodayCents).toBe(4900);
        expect(totals.firstChargeAt).toBeNull();
    });
});

describe("configuration options", () => {
    it("add their price to every period", () => {
        const { totals } = calculateQuote(
            input({ selections: [extraRam, extraIpv4] }),
        );

        // 19,99 € + 5,00 € + 2 × 1,50 €.
        expect(totals.recurringGrossCents).toBe(2799);
        // 10,00 € Produkt + 2 × 2,00 € Adresse.
        expect(totals.setupGrossCents).toBe(1400);
        expect(totals.dueTodayCents).toBe(4199);
    });

    it("are multiplied by the product quantity as well as their own", () => {
        const { lines, totals } = calculateQuote(
            input({ selections: [extraIpv4], quantity: 3 }),
        );

        const option = lines.find((line) => line.kind === "option");

        // Drei Produkte zu je zwei Adressen: sechs Adressen.
        expect(option?.quantity).toBe(6);
        expect(option?.amountCents).toBe(900);
        expect(totals.recurringGrossCents).toBe(5997 + 900);
    });

    it("show up as their own lines, priced per unit", () => {
        const { lines } = calculateQuote(
            input({ selections: [extraRam, extraIpv4] }),
        );

        expect(lines.map((line) => [line.kind, line.amountCents])).toEqual([
            ["base", 1999],
            ["option", 500],
            ["option", 300],
            ["setup", 1000],
            ["setup", 400],
        ]);
    });

    it("cost nothing when their value is free in this cycle", () => {
        const { lines, totals } = calculateQuote(
            input({
                selections: [{ ...extraRam, priceCents: 0, setupFeeCents: 0 }],
            }),
        );

        expect(totals.recurringGrossCents).toBe(1999);
        expect(lines.some((line) => line.kind === "option")).toBe(false);
    });
});

describe("the setup fee", () => {
    it("is charged today and never again", () => {
        const { totals } = calculateQuote(input());

        expect(totals.setupCents).toBe(1000);
        expect(totals.dueTodayCents).toBe(2999);
        // 19,99 € im nächsten Monat — ohne die Einrichtung.
        expect(totals.renewalCents).toBe(1999);
    });

    it("is still charged when the first period is free", () => {
        const { totals } = calculateQuote(
            input({
                pricing: {
                    cycle: "monthly",
                    currency: "EUR",
                    priceCents: 1999,
                    setupFeeCents: 1000,
                    trialDays: 30,
                },
            }),
        );

        expect(totals.dueTodayCents).toBe(1000);
    });
});

describe("a trial", () => {
    it("defers the first charge without changing what a period costs", () => {
        const { totals } = calculateQuote(
            input({
                pricing: {
                    cycle: "monthly",
                    currency: "EUR",
                    priceCents: 1999,
                    setupFeeCents: 0,
                    trialDays: 14,
                },
            }),
        );

        expect(totals.trialDays).toBe(14);
        expect(totals.dueTodayCents).toBe(0);
        expect(totals.firstPeriodCents).toBe(1999);
        expect(totals.renewalCents).toBe(1999);
        expect(totals.firstChargeAt?.toISOString()).toBe(
            "2026-11-21T10:00:00.000Z",
        );
    });

    it("charges immediately when there is none", () => {
        const { totals } = calculateQuote(input());

        expect(totals.firstChargeAt?.toISOString()).toBe(NOW.toISOString());
    });
});

describe("coupons", () => {
    it("once: the first period only", () => {
        const { totals, coupon: applied } = calculateQuote(
            input({ coupon: coupon({ percentBasisPoints: 2500 }) }),
        );

        // 25 % von 19,99 € sind 4,9975 € — aufgerundet 5,00 €.
        expect(totals.recurringDiscountCents).toBe(500);
        expect(totals.firstPeriodCents).toBe(1499);
        expect(totals.renewalCents).toBe(1999);
        expect(totals.discountPeriods).toBe(1);
        // 14,99 € erster Monat + 10,00 € Einrichtung, die der Code nicht senkt.
        expect(totals.dueTodayCents).toBe(2499);
        expect(applied?.label).toBe("25 %");
    });

    it("repeating: for the stated number of periods", () => {
        const { totals } = calculateQuote(
            input({
                coupon: coupon({
                    code: "DREIMONATE",
                    kind: "fixed",
                    percentBasisPoints: null,
                    amountCents: 500,
                    currency: "EUR",
                    duration: "repeating",
                    durationPeriods: 3,
                }),
            }),
        );

        expect(totals.recurringDiscountCents).toBe(500);
        expect(totals.firstPeriodCents).toBe(1499);
        // Nach dem dritten Zeitraum kostet er wieder den vollen Preis.
        expect(totals.renewalCents).toBe(1999);
        expect(totals.discountPeriods).toBe(3);
    });

    it("forever: every period, including the renewal", () => {
        const { totals } = calculateQuote(
            input({
                pricing: {
                    cycle: "monthly",
                    currency: "EUR",
                    priceCents: 2499,
                    setupFeeCents: 0,
                    trialDays: 0,
                },
                coupon: coupon({
                    code: "TREUE",
                    percentBasisPoints: 1000,
                    duration: "forever",
                }),
            }),
        );

        // 10 % von 24,99 € sind 2,499 € — abgerundet 2,49 €.
        expect(totals.recurringDiscountCents).toBe(250);
        expect(totals.firstPeriodCents).toBe(2249);
        expect(totals.renewalCents).toBe(2249);
        expect(totals.discountPeriods).toBeNull();
    });

    it("rounds a percentage half away from zero, onto whole cents", () => {
        const cases: [number, number, number][] = [
            // [Basispunkte, Preis in Cent, Rabatt in Cent]
            [1500, 1999, 300], // 299,85 → 300
            [5000, 1999, 1000], // 999,50 → 1000
            [3333, 1000, 333], // 333,30 → 333
            [100, 1999, 20], // 19,99 → 20
            [1, 1999, 0], // 0,1999 → 0
        ];

        for (const [basisPoints, priceCents, expected] of cases) {
            const { totals } = calculateQuote(
                input({
                    pricing: {
                        cycle: "monthly",
                        currency: "EUR",
                        priceCents,
                        setupFeeCents: 0,
                        trialDays: 0,
                    },
                    coupon: coupon({ percentBasisPoints: basisPoints }),
                }),
            );

            expect(
                totals.recurringDiscountCents,
                `${basisPoints / 100} % von ${priceCents}`,
            ).toBe(expected);
            expect(Number.isInteger(totals.firstPeriodCents)).toBe(true);
        }
    });

    it("discounts the options along with the base price", () => {
        const { totals } = calculateQuote(
            input({
                selections: [extraRam, extraIpv4],
                coupon: coupon({ percentBasisPoints: 1000 }),
            }),
        );

        // 10 % von 27,99 € sind 2,799 € — aufgerundet 2,80 €.
        expect(totals.recurringGrossCents).toBe(2799);
        expect(totals.recurringDiscountCents).toBe(280);
        expect(totals.firstPeriodCents).toBe(2519);
    });

    it("leaves the setup fee alone unless it says otherwise", () => {
        const without = calculateQuote(
            input({ coupon: coupon({ percentBasisPoints: 5000 }) }),
        );

        expect(without.totals.setupDiscountCents).toBe(0);
        expect(without.totals.setupCents).toBe(1000);

        const including = calculateQuote(
            input({
                coupon: coupon({
                    percentBasisPoints: 5000,
                    appliesToSetupFee: true,
                }),
            }),
        );

        expect(including.totals.setupDiscountCents).toBe(500);
        expect(including.totals.setupCents).toBe(500);
        // 9,99 € + 5,00 €: beide Hälften.
        expect(including.totals.dueTodayCents).toBe(1499);
    });

    it("never pays anything out when it is worth more than the order", () => {
        const { totals } = calculateQuote(
            input({
                coupon: coupon({
                    kind: "fixed",
                    percentBasisPoints: null,
                    amountCents: 5000,
                    currency: "EUR",
                }),
            }),
        );

        expect(totals.recurringDiscountCents).toBe(1999);
        expect(totals.firstPeriodCents).toBe(0);
        expect(totals.dueTodayCents).toBe(1000);
    });

    it("shows up as its own negative line", () => {
        const { lines } = calculateQuote(
            input({ coupon: coupon({ percentBasisPoints: 2500 }) }),
        );
        const discount = lines.find((line) => line.kind === "discount");

        expect(discount?.amountCents).toBe(-500);
        expect(discount?.label).toBe("Gutschein WILLKOMMEN");
        expect(discount?.detail).toBe("25 %, einmalig für den ersten Monat");

        // German articles are not interchangeable: der Monat, das Jahr.
        const yearly = calculateQuote(
            input({
                pricing: {
                    cycle: "annual",
                    currency: "EUR",
                    priceCents: 19_990,
                    setupFeeCents: 0,
                    trialDays: 0,
                },
                coupon: coupon({ percentBasisPoints: 2500 }),
            }),
        ).lines.find((line) => line.kind === "discount");

        expect(yearly?.detail).toBe("25 %, einmalig für das erste Jahr");
    });

    it("applies to the first charged period even behind a trial", () => {
        const { totals } = calculateQuote(
            input({
                pricing: {
                    cycle: "monthly",
                    currency: "EUR",
                    priceCents: 1999,
                    setupFeeCents: 0,
                    trialDays: 30,
                },
                coupon: coupon({ percentBasisPoints: 2500 }),
            }),
        );

        expect(totals.dueTodayCents).toBe(0);
        expect(totals.firstPeriodCents).toBe(1499);
        expect(totals.renewalCents).toBe(1999);
    });
});

describe("a coupon that does not apply", () => {
    const context = {
        productId: "product_01TESTVPSM",
        cycle: "monthly" as const,
        currency: "EUR",
        now: NOW,
    };

    const refused = (overrides: Partial<QuoteCoupon>) =>
        checkCoupon(coupon(overrides), context);

    it("names which rule refused it", () => {
        expect(refused({ active: false })).toEqual({
            ok: false,
            reason: "Dieser Gutscheincode ist nicht aktiv.",
        });

        expect(
            refused({ validFrom: new Date("2026-12-01T00:00:00.000Z") }),
        ).toMatchObject({ ok: false });

        expect(
            refused({ validUntil: new Date("2026-10-01T00:00:00.000Z") }),
        ).toEqual({
            ok: false,
            reason: "Dieser Gutscheincode ist abgelaufen.",
        });

        expect(refused({ maxRedemptions: 10, redemptions: 10 })).toEqual({
            ok: false,
            reason: "Dieser Gutscheincode ist bereits aufgebraucht.",
        });

        expect(refused({ productIds: ["product_01SOMETHINGELSE"] })).toEqual({
            ok: false,
            reason: "Dieser Gutscheincode gilt nicht für dieses Produkt.",
        });

        expect(refused({ cycles: ["annual"] })).toEqual({
            ok: false,
            reason: "Dieser Gutscheincode gilt nicht für diesen Abrechnungszeitraum.",
        });

        expect(
            refused({
                kind: "fixed",
                amountCents: 500,
                currency: "CHF",
                percentBasisPoints: null,
            }),
        ).toMatchObject({ ok: false });
    });

    it("leaves the price untouched and says why", () => {
        const {
            totals,
            coupon: applied,
            couponError,
        } = calculateQuote(
            input({
                coupon: coupon({
                    validUntil: new Date("2026-10-01T00:00:00.000Z"),
                }),
            }),
        );

        expect(applied).toBeNull();
        expect(couponError).toBe("Dieser Gutscheincode ist abgelaufen.");
        expect(totals.firstPeriodCents).toBe(1999);
        expect(totals.dueTodayCents).toBe(2999);
    });

    it("is accepted when it names this very product and cycle", () => {
        const { coupon: applied } = calculateQuote(
            input({
                coupon: coupon({
                    productIds: ["product_01TESTVPSM"],
                    cycles: ["monthly"],
                    maxRedemptions: 10,
                    redemptions: 9,
                }),
            }),
        );

        expect(applied?.code).toBe("WILLKOMMEN");
    });
});
