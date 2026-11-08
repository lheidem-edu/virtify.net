import type { BillingCycle, Coupon } from "@/db/schema";
import { add } from "@/lib/money";
import type { InvoiceItemInput } from "@/server/billing/invoices/service";
import type { BillingPeriod } from "@/server/billing/periods";
import {
    calculateQuote,
    type Quote,
    type QuoteCoupon,
    type QuoteSelection,
} from "@/server/billing/pricing";
import { buildInvoiceLines } from "@/server/orders/lines";

/**
 * What a subscription's next period costs, and the invoice lines that say so.
 *
 * Pure: snapshots in, a quote and lines out. No database, no clock it was
 * not handed.
 *
 * **It computes no price of its own.** Every figure comes out of
 * `calculateQuote()` — the same function the storefront, the cart and
 * `POST /api/v1/products/{id}/quote` come out of — and the lines come out of
 * `buildInvoiceLines()`, the same function the checkout's first invoice came
 * out of. A renewal that did its own multiplication would be the Phase 4
 * defect again, except that nobody would be looking at the screen when it
 * charged the wrong number.
 *
 * What it feeds the price function is the **snapshot on the subscription
 * item**, not the catalog: the catalog may be reprinted tomorrow and a
 * running Abo is not repriced by it. A price change reaches a customer by
 * way of a plan change they agreed to, and by no other route.
 */

/** One Abo position, as a renewal needs to see it. */
export type RenewalItem = {
    id: string;
    productId: string;
    description: string;
    quantity: number;
    /** Per unit, per **whole** period, as sold. */
    unitPriceCents: number;
    /** The add-ons at the prices they were sold at. */
    selections: QuoteSelection[];
};

/**
 * The coupon as a *renewal* must see it, which is not how a new order sees
 * it.
 *
 * Three of the checks `checkCoupon` makes are about whether the code may be
 * **redeemed**, and they have already been answered — by the order that
 * redeemed it. Applying them again at renewal would take a discount away
 * from somebody who was promised it:
 *
 *  - `maxRedemptions`: the counter went up when the order was placed. A code
 *    limited to 100 redemptions would otherwise stop discounting all 100
 *    subscriptions the moment the hundredth was sold.
 *  - `productIds` / `cycles`: the code was accepted for this product at this
 *    rhythm once already, and neither has changed under the subscription.
 *  - `active`: an operator retiring a code stops it being *handed out*; it
 *    does not retract an agreement already made.
 *
 * What does still apply is the clock. `valid_until` is the end of the offer,
 * and `discount_periods_remaining` is how many further periods were agreed —
 * when either runs out, the renewal is at the full price. Both are checked
 * here rather than in two places.
 */
export function renewalCoupon(input: {
    coupon: Coupon | null;
    /** `null` means every period; `0` means spent. */
    periodsRemaining: number | null;
    now: Date;
}): QuoteCoupon | null {
    const { coupon } = input;

    if (!coupon || input.periodsRemaining === 0) {
        return null;
    }

    if (coupon.validUntil && input.now > coupon.validUntil) {
        return null;
    }

    return {
        id: coupon.id,
        code: coupon.code,
        kind: coupon.kind,
        percentBasisPoints: coupon.percentBasisPoints,
        amountCents: coupon.amountCents,
        currency: coupon.currency,
        /**
         * Forced to `forever` for the length of this one quote. How long the
         * discount runs is `discount_periods_remaining` on the subscription,
         * counted down by the run as each renewal consumes one — the
         * coupon's own `duration` says how many periods were *granted*, and
         * re-reading it here would grant them all over again on every
         * renewal.
         */
        duration: "forever",
        durationPeriods: null,
        /** A renewal has no setup fee for a coupon to apply to. */
        appliesToSetupFee: false,
        // Redemption limits are the order's business; see above.
        productIds: [],
        cycles: [],
        validFrom: coupon.validFrom,
        validUntil: coupon.validUntil,
        maxRedemptions: null,
        redemptions: 0,
        active: true,
    };
}

export type RenewalQuoteInput = {
    item: RenewalItem;
    cycle: BillingCycle;
    currency: string;
    coupon: QuoteCoupon | null;
    now: Date;
    /**
     * The period being billed, where the caller knows it.
     *
     * Almost always a whole one, and then it changes nothing. It matters in
     * the one case where a renewal is **short**: the first paid period after
     * a trial, cut back to reach the billing anchor. Handing it to
     * `calculateQuote` is what makes the amount and the "anteilig für 16 von
     * 30 Tagen" on the same line agree — they come out of one function, and
     * prorating the line afterwards would be the second arithmetic this
     * project has already been bitten by.
     */
    period?: BillingPeriod;
};

/**
 * One item's next period, priced by the one price function.
 *
 * Every setup fee is zero and the trial is zero — both are things that
 * happen once, at the start, and a renewal is by definition not the start.
 *
 * Note that there are **two** sources of setup fee and both have to be
 * silenced: the product's own, and one per chosen add-on. A test caught the
 * second: a VPS with two extra IPv4 addresses at 5,00 € Einrichtung each
 * would otherwise have been charged 10,00 € more every single month, for
 * ever, under a line reading "Einrichtung" on a recurring invoice.
 */
export function renewalQuote(input: RenewalQuoteInput): Quote {
    return calculateQuote({
        product: { id: input.item.productId, name: input.item.description },
        pricing: {
            cycle: input.cycle,
            currency: input.currency,
            priceCents: input.item.unitPriceCents,
            setupFeeCents: 0,
            trialDays: 0,
        },
        selections: input.item.selections.map((selection) => ({
            ...selection,
            setupFeeCents: 0,
        })),
        quantity: input.item.quantity,
        coupon: input.coupon,
        now: input.now,
        firstPeriod: input.period?.prorated
            ? {
                  usedDays: input.period.usedDays,
                  periodDays: input.period.periodDays,
                  prorated: true,
              }
            : undefined,
    });
}

export type RenewalLines = {
    quote: Quote;
    lines: InvoiceItemInput[];
    /** What this item adds to the invoice, before tax. */
    netCents: number;
};

/** The invoice lines one item contributes to the renewal of `period`. */
export function renewalLines(
    input: RenewalQuoteInput & { period: BillingPeriod },
): RenewalLines {
    // The period goes into the quote as well as into the lines: one of them
    // decides the amount, the other the wording, and they have to be the
    // same period or the line says one thing and charges another.
    const quote = renewalQuote(input);
    const built = buildInvoiceLines(quote, input.period, { trialing: false });

    return {
        quote,
        lines: built.map((line) => ({
            description: line.description,
            detail: line.detail,
            quantity: line.quantity,
            unitCode: line.unitCode,
            unitPriceCents: line.unitPriceCents,
            servicePeriodStart: line.servicePeriodStart,
            servicePeriodEnd: line.servicePeriodEnd,
            subscriptionItemId: input.item.id,
        })),
        netCents: add(...built.map((line) => line.netCents)),
    };
}
