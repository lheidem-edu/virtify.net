import type { BillingCycle } from "@/db/schema/catalog";
import {
    calculateQuote,
    type Quote,
    type QuoteSelection,
} from "@/server/billing/pricing";
import {
    CatalogError,
    type Executor,
    getCouponByCode,
    loadProductDetail,
    type ProductDetail,
    toQuoteCoupon,
} from "@/server/catalog/repository";
import type { QuoteRequest } from "@/server/catalog/schema";

/**
 * One answer for every code that does not work here, whatever the reason.
 *
 * `checkCoupon` knows why — expired, wrong product, used up — and the admin
 * sees that. The storefront does not: a distinct "gibt es nicht" is an
 * oracle, and an unauthenticated endpoint that answers it will be walked
 * through the code space until it finds one that exists.
 */
export const CODE_NOT_APPLICABLE =
    "Dieser Gutscheincode gilt für diese Bestellung nicht.";

/**
 * The database's half of the price function: load the rows, check that what
 * was chosen is actually on offer, and hand it to `calculateQuote`.
 *
 * The storefront, the checkout of Phase 4 and
 * `POST /api/v1/products/{id}/quote` all come through here, which is what
 * makes "one price function" true rather than aspirational — the arithmetic
 * has one home and so does the validation in front of it.
 */

export type QuoteResult = {
    detail: ProductDetail;
    quote: Quote;
};

/**
 * Resolves what the customer chose against what the product offers.
 *
 * Deliberately strict. An option that is not this product's, a value that is
 * not that option's, or a quantity outside the option's bounds is refused
 * rather than ignored: a quote that quietly drops half the request is a price
 * for something the customer did not ask for.
 */
function resolveSelections(
    detail: ProductDetail,
    request: QuoteRequest,
): QuoteSelection[] {
    const chosen = new Map<string, (typeof request.options)[number]>();

    for (const entry of request.options) {
        if (chosen.has(entry.optionId)) {
            throw new CatalogError("Eine Option wurde doppelt angegeben.");
        }

        chosen.set(entry.optionId, entry);
    }

    const selections: QuoteSelection[] = [];

    for (const { option, values } of detail.options) {
        const entry = chosen.get(option.id);

        chosen.delete(option.id);

        if (!entry) {
            if (option.required) {
                throw new CatalogError(`Bitte „${option.name}“ auswählen.`);
            }

            continue;
        }

        const found = values.find((row) => row.value.id === entry.valueId);

        if (!found) {
            throw new CatalogError(
                `„${entry.valueId}“ gehört nicht zu „${option.name}“.`,
            );
        }

        let quantity = entry.quantity;

        if (option.type === "select") {
            quantity = 1;
        } else if (option.type === "checkbox") {
            quantity = quantity > 0 ? 1 : 0;
        } else if (
            quantity < option.minQuantity ||
            quantity > option.maxQuantity
        ) {
            throw new CatalogError(
                `„${option.name}“ nimmt zwischen ${option.minQuantity} und ${option.maxQuantity} Einheiten.`,
            );
        }

        if (quantity === 0) {
            if (option.required) {
                throw new CatalogError(`Bitte „${option.name}“ auswählen.`);
            }

            continue;
        }

        // A value with no price row for this cycle is included rather than
        // unavailable: the option exists, it simply costs nothing here.
        const cell = found.pricing.find(
            (row) =>
                row.cycle === request.cycle &&
                row.currency === request.currency,
        );

        selections.push({
            optionId: option.id,
            optionName: option.name,
            valueId: found.value.id,
            valueName: found.value.name,
            quantity,
            priceCents: cell?.priceCents ?? 0,
            setupFeeCents: cell?.setupFeeCents ?? 0,
        });
    }

    const stray = [...chosen.keys()][0];

    if (stray) {
        throw new CatalogError(`„${stray}“ ist keine Option dieses Produkts.`);
    }

    return selections;
}

export async function quoteProductDetail(
    db: Executor,
    detail: ProductDetail,
    request: QuoteRequest,
    now?: Date,
): Promise<QuoteResult> {
    const cell = detail.pricing.find(
        (row) =>
            row.cycle === (request.cycle as BillingCycle) &&
            row.currency === request.currency,
    );

    if (!cell) {
        throw new CatalogError(
            "Dieses Produkt wird in diesem Abrechnungszeitraum nicht angeboten.",
        );
    }

    if (request.quantity > detail.product.maxQuantity) {
        throw new CatalogError(
            `Von diesem Produkt lassen sich höchstens ${detail.product.maxQuantity} bestellen.`,
        );
    }

    const selections = resolveSelections(detail, request);

    const code = request.couponCode?.trim();
    const couponRow = code ? await getCouponByCode(db, code) : null;

    const quote = calculateQuote({
        product: { id: detail.product.id, name: detail.product.name },
        pricing: {
            cycle: cell.cycle,
            currency: cell.currency,
            priceCents: cell.priceCents,
            setupFeeCents: cell.setupFeeCents,
            trialDays: cell.trialDays,
        },
        selections,
        quantity: request.quantity,
        coupon: couponRow ? toQuoteCoupon(couponRow) : null,
        now,
    });

    // Every code that does not work gets the same answer, whatever the
    // reason: one that does not exist, one that has expired, one that is used
    // up and one that is for another product are indistinguishable from out
    // here. `checkCoupon` still computes the real reason and the admin can
    // read it; the unauthenticated endpoint does not hand it out.
    if (code && (!couponRow || quote.couponError)) {
        quote.couponError = CODE_NOT_APPLICABLE;
    }

    return { detail, quote };
}

/** The same thing starting from a product row. */
export async function quoteProduct(
    db: Executor,
    product: ProductDetail["product"],
    request: QuoteRequest,
    now?: Date,
): Promise<QuoteResult> {
    const detail = await loadProductDetail(db, product);

    if (!detail) {
        throw new CatalogError("Dieses Produkt gibt es nicht.");
    }

    return quoteProductDetail(db, detail, request, now);
}
