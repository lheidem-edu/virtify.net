import { describe, expect, it } from "vitest";
import type { Coupon } from "@/db/schema";
import { followingPeriod } from "@/server/billing/periods";
import {
    renewalCoupon,
    renewalLines,
    renewalQuote,
} from "@/server/billing/renewal";

/**
 * What a renewal charges.
 *
 * The claim under test is "one price, one function": the renewal's figures
 * come out of `calculateQuote()` fed with the subscription's own snapshot,
 * and nothing in this file does arithmetic of its own. The cases below say
 * the cents.
 */

const NOW = new Date("2026-11-10T10:00:00.000Z");

const ITEM = {
    id: "subscriptionitem_01",
    productId: "product_01",
    description: "VPS M",
    quantity: 1,
    unitPriceCents: 1999,
    selections: [],
};

function coupon(over: Partial<Coupon> = {}): Coupon {
    return {
        id: "coupon_01",
        code: "WILLKOMMEN",
        kind: "percent",
        percentBasisPoints: 2500,
        amountCents: null,
        currency: null,
        duration: "repeating",
        durationPeriods: 3,
        appliesToSetupFee: false,
        productIds: [],
        cycles: [],
        validFrom: null,
        validUntil: null,
        maxRedemptions: null,
        redemptions: 0,
        active: true,
        ...over,
    } as Coupon;
}

describe("what a renewal charges", () => {
    it("charges the snapshot price for a whole period", () => {
        const quote = renewalQuote({
            item: ITEM,
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            now: NOW,
        });

        expect(quote.totals.recurringGrossCents).toBe(1999);
        expect(quote.totals.firstPeriodCents).toBe(1999);
    });

    it("never charges the setup fee again", () => {
        const quote = renewalQuote({
            item: { ...ITEM, selections: [] },
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            now: NOW,
        });

        expect(quote.totals.setupCents).toBe(0);
        expect(quote.lines.some((line) => line.kind === "setup")).toBe(false);
    });

    it("never starts a new trial", () => {
        const quote = renewalQuote({
            item: ITEM,
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            now: NOW,
        });

        expect(quote.totals.trialDays).toBe(0);
        expect(quote.totals.dueTodayCents).toBe(1999);
    });

    it("adds the add-ons at the prices they were sold at", () => {
        // 19,99 € + 2 × 2,00 € IPv4 = 23,99 €
        const quote = renewalQuote({
            item: {
                ...ITEM,
                selections: [
                    {
                        optionId: "configoption_01",
                        optionName: "Zusätzliche IPv4",
                        valueId: "configoptionvalue_01",
                        valueName: "je Adresse",
                        quantity: 2,
                        priceCents: 200,
                        setupFeeCents: 500,
                    },
                ],
            },
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            now: NOW,
        });

        expect(quote.totals.recurringGrossCents).toBe(2399);
        // The add-on's own setup fee is a once-only charge too.
        expect(quote.totals.setupCents).toBe(0);
    });

    it("multiplies by the quantity — 3 × 19,99 € = 59,97 €", () => {
        const quote = renewalQuote({
            item: { ...ITEM, quantity: 3 },
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            now: NOW,
        });

        expect(quote.totals.recurringGrossCents).toBe(5997);
    });

    it("applies the coupon — 25 % off 19,99 € is 15,00 €", () => {
        // 25 % of 1999 is 499,75 → 500 half away from zero.
        const quote = renewalQuote({
            item: ITEM,
            cycle: "monthly",
            currency: "EUR",
            coupon: renewalCoupon({
                coupon: coupon(),
                periodsRemaining: 2,
                now: NOW,
            }),
            now: NOW,
        });

        expect(quote.totals.recurringDiscountCents).toBe(500);
        expect(quote.totals.firstPeriodCents).toBe(1499);
    });
});

describe("the coupon a renewal is allowed to use", () => {
    it("ignores the redemption limit — that was the order's business", () => {
        // A code limited to 100 redemptions must not stop discounting all
        // 100 subscriptions the moment the hundredth is sold.
        const mapped = renewalCoupon({
            coupon: coupon({ maxRedemptions: 100, redemptions: 100 }),
            periodsRemaining: null,
            now: NOW,
        });

        expect(mapped).not.toBeNull();
        expect(mapped?.maxRedemptions).toBeNull();
        expect(mapped?.redemptions).toBe(0);
    });

    it("ignores a product or cycle restriction the order already satisfied", () => {
        const mapped = renewalCoupon({
            coupon: coupon({
                productIds: ["product_somewhere_else"],
                cycles: ["annual"],
            }),
            periodsRemaining: null,
            now: NOW,
        });

        expect(mapped?.productIds).toEqual([]);
        expect(mapped?.cycles).toEqual([]);
    });

    it("keeps discounting after the code has been retired", () => {
        // Retiring a code stops it being handed out; it does not retract an
        // agreement already made.
        expect(
            renewalCoupon({
                coupon: coupon({ active: false }),
                periodsRemaining: 1,
                now: NOW,
            }),
        ).not.toBeNull();
    });

    it("stops when the agreed periods are spent", () => {
        expect(
            renewalCoupon({
                coupon: coupon(),
                periodsRemaining: 0,
                now: NOW,
            }),
        ).toBeNull();
    });

    it("stops when the offer itself has expired", () => {
        expect(
            renewalCoupon({
                coupon: coupon({
                    validUntil: new Date("2026-11-01T00:00:00.000Z"),
                }),
                periodsRemaining: 5,
                now: NOW,
            }),
        ).toBeNull();
    });

    it("never re-grants the coupon's own duration", () => {
        // `duration` is forced to `forever` for the length of one quote:
        // how many periods are left is the subscription's counter, and
        // reading the coupon's `durationPeriods` here would hand out three
        // more periods on every renewal, for ever.
        const mapped = renewalCoupon({
            coupon: coupon({ duration: "once", durationPeriods: 1 }),
            periodsRemaining: 2,
            now: NOW,
        });

        expect(mapped?.duration).toBe("forever");
        expect(mapped?.durationPeriods).toBeNull();
    });

    it("never applies to a setup fee, because a renewal has none", () => {
        expect(
            renewalCoupon({
                coupon: coupon({ appliesToSetupFee: true }),
                periodsRemaining: null,
                now: NOW,
            })?.appliesToSetupFee,
        ).toBe(false);
    });

    it("is nothing at all when the Abo carries no coupon", () => {
        expect(
            renewalCoupon({ coupon: null, periodsRemaining: 3, now: NOW }),
        ).toBeNull();
    });
});

describe("the lines a renewal puts on the invoice", () => {
    const period = followingPeriod(
        new Date("2026-12-01T00:00:00.000+01:00"),
        "monthly",
    );

    it("names the period it bills, with the last covered day", () => {
        const built = renewalLines({
            item: ITEM,
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            period,
            now: NOW,
        });

        expect(built.lines).toHaveLength(1);
        expect(built.lines[0].servicePeriodStart).toEqual(period.start);
        // Exclusive end, printed as the last instant actually covered: the
        // next invoice claims the 1st of January, this one must not.
        expect(built.lines[0].servicePeriodEnd?.getTime()).toBe(
            (period.end as Date).getTime() - 1,
        );
    });

    it("says nothing about proration, because a renewal is a whole period", () => {
        const built = renewalLines({
            item: ITEM,
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            period,
            now: NOW,
        });

        expect(built.lines[0].detail ?? "").not.toMatch(/anteilig/);
        expect(built.netCents).toBe(1999);
    });

    it("carries the Abo position, so the line can be explained later", () => {
        const built = renewalLines({
            item: ITEM,
            cycle: "monthly",
            currency: "EUR",
            coupon: null,
            period,
            now: NOW,
        });

        expect(built.lines[0].subscriptionItemId).toBe(ITEM.id);
    });

    it("puts the discount on its own line and nets out to the charged figure", () => {
        const built = renewalLines({
            item: ITEM,
            cycle: "monthly",
            currency: "EUR",
            coupon: renewalCoupon({
                coupon: coupon(),
                periodsRemaining: 1,
                now: NOW,
            }),
            period,
            now: NOW,
        });

        expect(built.lines).toHaveLength(2);
        expect(built.lines[1].unitPriceCents).toBe(-500);
        expect(built.netCents).toBe(1499);
    });
});
