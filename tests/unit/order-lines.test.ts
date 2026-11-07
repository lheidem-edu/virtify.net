import { describe, expect, it } from "vitest";
import { add } from "@/lib/money";
import { firstPeriod } from "@/server/billing/periods";
import { calculateQuote, type QuoteCoupon } from "@/server/billing/pricing";
import {
    buildInvoiceLines,
    remainingDiscountPeriods,
    UNIT_CODE,
} from "@/server/orders/lines";

/**
 * What a quote puts on the first invoice, in cents.
 *
 * The claim these tests are here to defend is the one the whole phase rests
 * on: **the order total is the invoice total**, because both are the same
 * lines added up by the same `multiply`. Every number below is written out
 * rather than computed, so a change in the arithmetic fails here rather
 * than quietly agreeing with itself.
 */

const NOW = new Date("2026-11-07T10:00:00.000Z");

function quoteFor(options: {
    priceCents: number;
    setupFeeCents?: number;
    trialDays?: number;
    quantity?: number;
    coupon?: QuoteCoupon | null;
    cycle?: "monthly" | "annual" | "onetime";
}) {
    return calculateQuote({
        product: { id: "product_X", name: "VPS M" },
        pricing: {
            cycle: options.cycle ?? "monthly",
            currency: "EUR",
            priceCents: options.priceCents,
            setupFeeCents: options.setupFeeCents ?? 0,
            trialDays: options.trialDays ?? 0,
        },
        quantity: options.quantity ?? 1,
        coupon: options.coupon ?? null,
        now: NOW,
    });
}

const WHOLE_MONTH = firstPeriod({
    start: NOW,
    cycle: "monthly",
    anchorDay: 0,
});

/** 7 November to 1 December: 24 days of a 30-day period. */
const ANCHORED = firstPeriod({ start: NOW, cycle: "monthly", anchorDay: 1 });

const coupon = (patch: Partial<QuoteCoupon>): QuoteCoupon => ({
    id: "coupon_X",
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
    ...patch,
});

const sum = (lines: { netCents: number }[]) =>
    add(...lines.map((line) => line.netCents));

describe("the first invoice's lines", () => {
    it("charges the period and the setup fee on day one", () => {
        // 19,99 €/Monat plus 10,00 € Einrichtung.
        const quote = quoteFor({ priceCents: 1999, setupFeeCents: 1000 });
        const lines = buildInvoiceLines(quote, WHOLE_MONTH, {
            trialing: false,
        });

        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({
            description: "VPS M",
            quantity: 1,
            unitPriceCents: 1999,
            unitCode: "MON",
            netCents: 1999,
        });
        expect(lines[0].servicePeriodStart).toEqual(WHOLE_MONTH.start);
        expect(lines[0].servicePeriodEnd).toEqual(WHOLE_MONTH.end);

        expect(lines[1]).toMatchObject({
            description: "Einrichtung: VPS M",
            unitPriceCents: 1000,
            unitCode: "C62",
            netCents: 1000,
        });
        // A one-off line is not a span of time and carries no period.
        expect(lines[1].servicePeriodStart).toBeNull();

        expect(sum(lines)).toBe(2999);
        expect(sum(lines)).toBe(quote.totals.dueTodayCents);
    });

    it("keeps the quantity on the line, and multiplies it once", () => {
        const quote = quoteFor({
            priceCents: 1999,
            setupFeeCents: 1000,
            quantity: 3,
        });
        const lines = buildInvoiceLines(quote, WHOLE_MONTH, {
            trialing: false,
        });

        expect(lines[0]).toMatchObject({
            quantity: 3,
            unitPriceCents: 1999,
            netCents: 5997,
        });
        expect(sum(lines)).toBe(8997);
        expect(sum(lines)).toBe(quote.totals.dueTodayCents);
    });

    it("leaves out the period during a trial but still charges the setup", () => {
        const quote = quoteFor({
            priceCents: 1999,
            setupFeeCents: 1000,
            trialDays: 14,
        });
        const lines = buildInvoiceLines(quote, WHOLE_MONTH, { trialing: true });

        expect(lines).toHaveLength(1);
        expect(lines[0].description).toBe("Einrichtung: VPS M");
        expect(sum(lines)).toBe(1000);
        expect(sum(lines)).toBe(quote.totals.dueTodayCents);
    });

    it("produces no line at all for a trial with no setup fee", () => {
        // This is what "a trial produces no first charge" means: there is
        // nothing to invoice, so no invoice is issued — not one over 0,00 €.
        const quote = quoteFor({ priceCents: 1999, trialDays: 14 });
        const lines = buildInvoiceLines(quote, WHOLE_MONTH, { trialing: true });

        expect(lines).toHaveLength(0);
        expect(quote.totals.dueTodayCents).toBe(0);
    });

    it("carries the discount as its own negative line", () => {
        // 25 % of 19,99 € is 4,9975 € → 5,00 €, so the period is 14,99 €.
        const quote = quoteFor({
            priceCents: 1999,
            coupon: coupon({}),
        });
        const lines = buildInvoiceLines(quote, WHOLE_MONTH, {
            trialing: false,
        });

        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatchObject({
            description: "Gutschein WILLKOMMEN",
            quantity: 1,
            unitPriceCents: -500,
            netCents: -500,
        });
        expect(sum(lines)).toBe(1499);
        expect(sum(lines)).toBe(quote.totals.dueTodayCents);
    });

    it("spends a fixed coupon's one budget across both sides", () => {
        // Phase 2's defect: a 10,00 € code once took 10,00 € off the period
        // *and* 10,00 € off the setup fee. One budget, so 20,00 € + 15,00 €
        // less 10,00 € is 25,00 €, not 15,00 €.
        const quote = quoteFor({
            priceCents: 2000,
            setupFeeCents: 1500,
            coupon: coupon({
                kind: "fixed",
                percentBasisPoints: null,
                amountCents: 1000,
                currency: "EUR",
                appliesToSetupFee: true,
            }),
        });
        const lines = buildInvoiceLines(quote, WHOLE_MONTH, {
            trialing: false,
        });

        expect(sum(lines)).toBe(2500);
        expect(sum(lines)).toBe(quote.totals.dueTodayCents);
    });

    it("prorates the recurring lines, and only those", () => {
        const quote = quoteFor({ priceCents: 1999, setupFeeCents: 1000 });
        const lines = buildInvoiceLines(quote, ANCHORED, { trialing: false });

        expect(ANCHORED.usedDays).toBe(24);
        expect(ANCHORED.periodDays).toBe(30);

        // 19,99 € × 24/30 = 15,992 € → 15,99 €.
        expect(lines[0].unitPriceCents).toBe(1599);
        expect(lines[0].netCents).toBe(1599);
        expect(lines[0].detail).toContain("anteilig für 24 von 30 Tagen");
        // The period reads to the last day it covers, not to the exclusive
        // end — 30.11., not 01.12.
        expect(lines[0].detail).toContain("07.11.2026 – 30.11.2026");

        // The Einrichtungsgebühr is work done once, not a span of time.
        expect(lines[1].unitPriceCents).toBe(1000);
        expect(lines[1].detail).toBeNull();

        expect(sum(lines)).toBe(2599);
    });

    it("prorates a discount line with the gross it belongs to", () => {
        const quote = quoteFor({ priceCents: 1999, coupon: coupon({}) });
        const lines = buildInvoiceLines(quote, ANCHORED, { trialing: false });

        // 19,99 € × 24/30 → 15,99 €; 5,00 € × 24/30 = 4,00 € exactly.
        expect(lines[0].netCents).toBe(1599);
        expect(lines[1].netCents).toBe(-400);
        expect(sum(lines)).toBe(1199);
    });

    it("gives a recurring line the unit code of its cycle", () => {
        const annual = quoteFor({ priceCents: 19_990, cycle: "annual" });
        const lines = buildInvoiceLines(
            annual,
            firstPeriod({ start: NOW, cycle: "annual", anchorDay: 0 }),
            { trialing: false },
        );

        expect(lines[0].unitCode).toBe("ANN");
        expect(UNIT_CODE.monthly).toBe("MON");
        expect(UNIT_CODE.quarterly).toBe("QAN");
        expect(UNIT_CODE.semiannual).toBe("SAN");
    });

    it("treats a one-off sale as a piece with no period", () => {
        const quote = quoteFor({ priceCents: 4999, cycle: "onetime" });
        const lines = buildInvoiceLines(
            quote,
            firstPeriod({ start: NOW, cycle: "onetime", anchorDay: 1 }),
            { trialing: false },
        );

        expect(lines[0].unitCode).toBe("C62");
        expect(lines[0].servicePeriodStart).toBeNull();
        expect(lines[0].servicePeriodEnd).toBeNull();
        expect(sum(lines)).toBe(4999);
    });
});

describe("what is left of a coupon after the checkout", () => {
    it("deducts the period the first invoice already discounted", () => {
        expect(remainingDiscountPeriods(1, true)).toBe(0);
        expect(remainingDiscountPeriods(3, true)).toBe(2);
    });

    it("deducts nothing while the subscription is on trial", () => {
        // Nothing was billed, so nothing was discounted.
        expect(remainingDiscountPeriods(1, false)).toBe(1);
        expect(remainingDiscountPeriods(3, false)).toBe(3);
    });

    it("keeps `forever` forever and never goes below zero", () => {
        expect(remainingDiscountPeriods(null, true)).toBeNull();
        expect(remainingDiscountPeriods(0, true)).toBe(0);
    });
});
