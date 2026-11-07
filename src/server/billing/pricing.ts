import type { BillingCycle } from "@/db/schema/catalog";
import { add, multiply, percent, subtract } from "@/lib/money";

/**
 * The one price function.
 *
 * Every price the customer is ever shown or charged comes out of here: the
 * storefront's live total, the checkout of Phase 4, and
 * `POST /api/v1/products/{id}/quote`. A second implementation anywhere would
 * be a second answer, and the one that disagreed with the invoice would be
 * the one the customer read before they ordered.
 *
 * It is pure — no database, no clock it did not get as an argument — so a
 * test can state a price in cents and be told exactly what is charged.
 * `quoteProduct()` in ./quote.ts loads the rows and calls this.
 *
 * All arithmetic goes through src/lib/money.ts. There is no float in here.
 */

export type QuoteCouponKind = "percent" | "fixed";
export type QuoteCouponDuration = "once" | "repeating" | "forever";

export type QuoteCoupon = {
    id: string;
    code: string;
    kind: QuoteCouponKind;
    /** 2500 is 25 %, 1550 is 15,5 %. Integer, so the rate itself cannot drift. */
    percentBasisPoints: number | null;
    amountCents: number | null;
    currency: string | null;
    duration: QuoteCouponDuration;
    durationPeriods: number | null;
    appliesToSetupFee: boolean;
    /** Empty means every product. */
    productIds: string[];
    /** Empty means every cycle. */
    cycles: string[];
    validFrom: Date | null;
    validUntil: Date | null;
    maxRedemptions: number | null;
    redemptions: number;
    active: boolean;
};

/** One chosen add-on, already resolved to the value's price for this cycle. */
export type QuoteSelection = {
    optionId: string;
    optionName: string;
    valueId: string;
    valueName: string;
    /** Units of this value: 1 for a select or a ticked checkbox. */
    quantity: number;
    /** Per unit, per period. */
    priceCents: number;
    /** Per unit, once. */
    setupFeeCents: number;
};

export type QuoteInput = {
    product: { id: string; name: string };
    pricing: {
        cycle: BillingCycle;
        currency: string;
        priceCents: number;
        setupFeeCents: number;
        trialDays: number;
    };
    selections?: QuoteSelection[];
    quantity?: number;
    coupon?: QuoteCoupon | null;
    /** Defaults to now; passed in by tests and by anything with a fake clock. */
    now?: Date;
};

export type QuoteLine = {
    kind: "base" | "option" | "setup" | "discount";
    label: string;
    detail?: string;
    quantity: number;
    unitAmountCents: number;
    amountCents: number;
    /** `true`: every period. `false`: once, at the start. */
    recurring: boolean;
    optionId?: string;
    valueId?: string;
};

export type QuoteTotals = {
    currency: string;
    cycle: BillingCycle;
    /** Base plus add-ons for one period, before any coupon. */
    recurringGrossCents: number;
    /** What the coupon takes off one period. */
    recurringDiscountCents: number;
    /** One period while the coupon applies. */
    firstPeriodCents: number;
    /** One period once it no longer does; 0 for a one-off sale. */
    renewalCents: number;
    setupGrossCents: number;
    setupDiscountCents: number;
    setupCents: number;
    /** Charged at checkout. A trial defers the period but not the setup fee. */
    dueTodayCents: number;
    trialDays: number;
    /** When the first recurring charge falls; null for a one-off sale. */
    firstChargeAt: Date | null;
    /** How many periods the discount covers: `null` means every one. */
    discountPeriods: number | null;
};

export type Quote = {
    productId: string;
    productName: string;
    lines: QuoteLine[];
    totals: QuoteTotals;
    coupon: { id: string; code: string; label: string } | null;
    /** Why a code was not applied. German — it is shown to the customer. */
    couponError: string | null;
};

export const CYCLE_LABEL: Record<BillingCycle, string> = {
    monthly: "monatlich",
    quarterly: "vierteljährlich",
    semiannual: "halbjährlich",
    annual: "jährlich",
    biennial: "zweijährlich",
    onetime: "einmalig",
};

/**
 * "the first period", declined. The whole phrase rather than the bare noun,
 * because German articles are not interchangeable: der Monat but das Jahr,
 * so "für den ersten ${noun}" is wrong for four of the six cycles.
 */
const CYCLE_FIRST_PERIOD: Record<BillingCycle, string> = {
    monthly: "den ersten Monat",
    quarterly: "das erste Quartal",
    semiannual: "das erste Halbjahr",
    annual: "das erste Jahr",
    biennial: "die ersten zwei Jahre",
    onetime: "einmalig",
};

/** The noun, for a line that names one period rather than a rhythm. */
export const CYCLE_PERIOD_LABEL: Record<BillingCycle, string> = {
    monthly: "Monat",
    quarterly: "Quartal",
    semiannual: "Halbjahr",
    annual: "Jahr",
    biennial: "zwei Jahre",
    onetime: "einmalig",
};

const DAY_MS = 86_400_000;

/**
 * Whether a coupon may be used here, and why not when it may not. Separate
 * from the arithmetic because the storefront wants to say *which* rule
 * refused the code, not merely that the total did not move.
 */
export function checkCoupon(
    coupon: QuoteCoupon,
    context: {
        productId: string;
        cycle: BillingCycle;
        currency: string;
        now?: Date;
    },
): { ok: true } | { ok: false; reason: string } {
    const now = context.now ?? new Date();

    if (!coupon.active) {
        return { ok: false, reason: "Dieser Gutscheincode ist nicht aktiv." };
    }

    if (coupon.validFrom && now < coupon.validFrom) {
        return {
            ok: false,
            reason: "Dieser Gutscheincode gilt noch nicht.",
        };
    }

    if (coupon.validUntil && now > coupon.validUntil) {
        return { ok: false, reason: "Dieser Gutscheincode ist abgelaufen." };
    }

    if (
        coupon.maxRedemptions !== null &&
        coupon.redemptions >= coupon.maxRedemptions
    ) {
        return {
            ok: false,
            reason: "Dieser Gutscheincode ist bereits aufgebraucht.",
        };
    }

    if (
        coupon.productIds.length > 0 &&
        !coupon.productIds.includes(context.productId)
    ) {
        return {
            ok: false,
            reason: "Dieser Gutscheincode gilt nicht für dieses Produkt.",
        };
    }

    if (coupon.cycles.length > 0 && !coupon.cycles.includes(context.cycle)) {
        return {
            ok: false,
            reason: "Dieser Gutscheincode gilt nicht für diesen Abrechnungszeitraum.",
        };
    }

    if (
        coupon.kind === "fixed" &&
        coupon.currency &&
        coupon.currency !== context.currency
    ) {
        return {
            ok: false,
            reason: `Dieser Gutscheincode gilt nur für Beträge in ${coupon.currency}.`,
        };
    }

    return { ok: true };
}

/**
 * What the coupon takes off `base`. Never more than `base` itself: a 20 €
 * code against a 15 € order is a 15 € discount, not a 5 € payout.
 *
 * A percentage is rounded half away from zero to whole cents by
 * `money.percent`, so 15 % of 19,99 € is 3,00 € and not 2,9985 € carried
 * around as a float until an invoice disagrees with the cart.
 */
function discountOn(base: number, coupon: QuoteCoupon): number {
    if (base <= 0) {
        return 0;
    }

    const raw =
        coupon.kind === "percent"
            ? percent(base, (coupon.percentBasisPoints ?? 0) / 100)
            : (coupon.amountCents ?? 0);

    return Math.max(0, Math.min(base, raw));
}

export function calculateQuote(input: QuoteInput): Quote {
    const quantity = input.quantity ?? 1;

    if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw new Error(`Menge muss eine ganze Zahl ab 1 sein: ${quantity}`);
    }

    const { pricing, product } = input;
    const selections = input.selections ?? [];
    const now = input.now ?? new Date();
    const oneOff = pricing.cycle === "onetime";
    const lines: QuoteLine[] = [];

    // --- recurring side ---------------------------------------------------

    const baseAmount = multiply(pricing.priceCents, quantity);

    lines.push({
        kind: "base",
        label: product.name,
        detail: CYCLE_LABEL[pricing.cycle],
        quantity,
        unitAmountCents: pricing.priceCents,
        amountCents: baseAmount,
        recurring: !oneOff,
    });

    for (const selection of selections) {
        const units = quantity * selection.quantity;

        if (units === 0) {
            continue;
        }

        if (selection.priceCents !== 0) {
            lines.push({
                kind: "option",
                label: `${selection.optionName}: ${selection.valueName}`,
                quantity: units,
                unitAmountCents: selection.priceCents,
                amountCents: multiply(selection.priceCents, units),
                recurring: !oneOff,
                optionId: selection.optionId,
                valueId: selection.valueId,
            });
        }
    }

    const recurringGrossCents = add(
        ...lines
            .filter((line) => line.kind === "base" || line.kind === "option")
            .map((line) => line.amountCents),
    );

    // --- setup side -------------------------------------------------------

    const setupLines: QuoteLine[] = [];

    if (pricing.setupFeeCents !== 0) {
        setupLines.push({
            kind: "setup",
            label: `Einrichtung: ${product.name}`,
            quantity,
            unitAmountCents: pricing.setupFeeCents,
            amountCents: multiply(pricing.setupFeeCents, quantity),
            recurring: false,
        });
    }

    for (const selection of selections) {
        const units = quantity * selection.quantity;

        if (units === 0 || selection.setupFeeCents === 0) {
            continue;
        }

        setupLines.push({
            kind: "setup",
            label: `Einrichtung: ${selection.optionName} — ${selection.valueName}`,
            quantity: units,
            unitAmountCents: selection.setupFeeCents,
            amountCents: multiply(selection.setupFeeCents, units),
            recurring: false,
            optionId: selection.optionId,
            valueId: selection.valueId,
        });
    }

    lines.push(...setupLines);

    const setupGrossCents = add(...setupLines.map((line) => line.amountCents));

    // --- coupon -----------------------------------------------------------

    const submitted = input.coupon ?? null;
    let applied: QuoteCoupon | null = null;
    let couponError: string | null = null;

    if (submitted) {
        const verdict = checkCoupon(submitted, {
            productId: product.id,
            cycle: pricing.cycle,
            currency: pricing.currency,
            now,
        });

        if (verdict.ok) {
            applied = submitted;
        } else {
            couponError = verdict.reason;
        }
    }

    const recurringDiscountCents = applied
        ? discountOn(recurringGrossCents, applied)
        : 0;
    const setupDiscountCents = applied?.appliesToSetupFee
        ? discountOn(setupGrossCents, applied)
        : 0;

    if (applied && recurringDiscountCents > 0) {
        lines.push({
            kind: "discount",
            label: `Gutschein ${applied.code}`,
            detail: discountDetail(applied, pricing.cycle),
            quantity: 1,
            unitAmountCents: -recurringDiscountCents,
            amountCents: -recurringDiscountCents,
            recurring: !oneOff,
        });
    }

    if (applied && setupDiscountCents > 0) {
        lines.push({
            kind: "discount",
            label: `Gutschein ${applied.code} auf die Einrichtung`,
            quantity: 1,
            unitAmountCents: -setupDiscountCents,
            amountCents: -setupDiscountCents,
            recurring: false,
        });
    }

    // --- totals -----------------------------------------------------------

    const firstPeriodCents = subtract(
        recurringGrossCents,
        recurringDiscountCents,
    );
    const setupCents = subtract(setupGrossCents, setupDiscountCents);

    // A one-off sale has nothing to renew and nothing to try out first.
    const trialDays = oneOff ? 0 : pricing.trialDays;

    const renewalCents = oneOff
        ? 0
        : applied?.duration === "forever"
          ? firstPeriodCents
          : recurringGrossCents;

    /**
     * The trial defers the period, not the setup fee: the work of setting the
     * service up happens on day one whether or not the first month is free,
     * and that is how every panel this replaces behaves. A coupon on the
     * setup fee still applies today.
     */
    const dueTodayCents =
        trialDays > 0 ? setupCents : add(firstPeriodCents, setupCents);

    const discountPeriods = !applied
        ? 0
        : applied.duration === "forever"
          ? null
          : applied.duration === "repeating"
            ? Math.max(1, applied.durationPeriods ?? 1)
            : 1;

    return {
        productId: product.id,
        productName: product.name,
        lines,
        totals: {
            currency: pricing.currency,
            cycle: pricing.cycle,
            recurringGrossCents,
            recurringDiscountCents,
            firstPeriodCents,
            renewalCents,
            setupGrossCents,
            setupDiscountCents,
            setupCents,
            dueTodayCents,
            trialDays,
            firstChargeAt: oneOff
                ? null
                : new Date(now.getTime() + trialDays * DAY_MS),
            discountPeriods,
        },
        coupon: applied
            ? {
                  id: applied.id,
                  code: applied.code,
                  label: couponLabel(applied),
              }
            : null,
        couponError,
    };
}

/** "25 %" or "5,00 €" — what the code is worth, for a line's label. */
export function couponLabel(coupon: QuoteCoupon): string {
    if (coupon.kind === "percent") {
        const basisPoints = coupon.percentBasisPoints ?? 0;

        return `${(basisPoints / 100).toLocaleString("de-DE", {
            maximumFractionDigits: 2,
        })} %`;
    }

    return `${((coupon.amountCents ?? 0) / 100).toLocaleString("de-DE", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })} ${coupon.currency ?? "EUR"}`;
}

/** How long it runs, in words, for the small print under the discount line. */
function discountDetail(coupon: QuoteCoupon, cycle: BillingCycle): string {
    if (cycle === "onetime") {
        return couponLabel(coupon);
    }

    const period = CYCLE_FIRST_PERIOD[cycle];

    switch (coupon.duration) {
        case "forever":
            return `${couponLabel(coupon)}, dauerhaft`;
        case "repeating": {
            const periods = Math.max(1, coupon.durationPeriods ?? 1);

            return periods === 1
                ? `${couponLabel(coupon)}, für ${period}`
                : `${couponLabel(coupon)}, für ${periods} Abrechnungszeiträume`;
        }
        default:
            return `${couponLabel(coupon)}, einmalig für ${period}`;
    }
}
