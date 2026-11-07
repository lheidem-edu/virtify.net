import type { BillingCycle, Cart, CartItem } from "@/db/schema";
import { add } from "@/lib/money";
import type { Quote, QuoteSelection } from "@/server/billing/pricing";
import { quoteProductDetail } from "@/server/billing/quote";
import type { CartSelection } from "@/server/cart/repository";
import { loadSellableProduct } from "@/server/catalog/lookup";
import {
    CatalogError,
    type Executor,
    type ProductDetail,
} from "@/server/catalog/repository";
import { quoteRequestSchema } from "@/server/catalog/schema";

/**
 * What a cart costs — asked, never assumed.
 *
 * Every figure on this page comes back from `quoteProductDetail`, which is
 * `calculateQuote()` with the catalog rows in front of it: the same call the
 * product page makes, the same call `POST /api/v1/products/{id}/quote`
 * makes, and the same call the checkout makes when it writes the order. The
 * cart adds the per-item results up and does nothing else with money.
 *
 * Pricing can fail — a product retired since it was added, an option
 * withdrawn, a quantity that is no longer allowed — and a cart that quietly
 * dropped such an item would be a cart whose total is for something else.
 * Each one becomes a `problem` on its entry instead, and a cart with any
 * problem cannot be ordered.
 */

export type CartEntry = {
    item: CartItem;
    detail: ProductDetail | null;
    quote: Quote | null;
    /** The chosen add-ons, resolved to names and prices. */
    selections: QuoteSelection[];
    /** German, shown to the customer; null when the item priced cleanly. */
    problem: string | null;
};

export type CycleTotal = {
    cycle: BillingCycle;
    /** One period while the coupons apply. */
    firstPeriodCents: number;
    /** One period once they no longer do. */
    renewalCents: number;
};

export type PricedCart = {
    cart: Cart;
    entries: CartEntry[];
    currency: string;
    /** Items that priced cleanly, in cart order. */
    itemCount: number;
    /** What the order would charge today, before tax. */
    dueTodayCents: number;
    setupCents: number;
    /** The running cost, kept apart per billing cycle. */
    recurring: CycleTotal[];
    problems: string[];
    /** False when the cart is empty or any item could not be priced. */
    orderable: boolean;
};

/** The selections as stored, defensively — jsonb is whatever was written. */
export function readSelections(value: unknown): CartSelection[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const parsed = quoteRequestSchema.shape.options.safeParse(value);

    return parsed.success
        ? parsed.data.map((entry) => ({
              optionId: entry.optionId,
              valueId: entry.valueId,
              quantity: entry.quantity,
          }))
        : [];
}

/**
 * Prices one cart item. Exported because the checkout prices the very same
 * way before it writes an order — one function, one answer.
 */
export async function priceCartItem(
    db: Executor,
    item: CartItem,
    now?: Date,
): Promise<CartEntry> {
    const detail = await loadSellableProduct(db, item.productId);

    if (!detail) {
        return {
            item,
            detail: null,
            quote: null,
            selections: [],
            problem: "Dieses Produkt wird nicht mehr angeboten.",
        };
    }

    try {
        const { quote, selections } = await quoteProductDetail(
            db,
            detail,
            {
                cycle: item.cycle,
                currency: item.currency,
                quantity: item.quantity,
                options: readSelections(item.selections),
                couponCode: item.couponCode,
            },
            now,
        );

        return { item, detail, quote, selections, problem: null };
    } catch (error) {
        if (error instanceof CatalogError) {
            return {
                item,
                detail,
                quote: null,
                selections: [],
                problem: error.message,
            };
        }

        throw error;
    }
}

export async function priceCart(
    db: Executor,
    cart: Cart,
    items: CartItem[],
    now?: Date,
): Promise<PricedCart> {
    const entries: CartEntry[] = [];

    for (const item of items) {
        entries.push(await priceCartItem(db, item, now));
    }

    const priced = entries.filter((entry) => entry.quote !== null);
    const recurring: CycleTotal[] = [];

    for (const entry of priced) {
        const totals = entry.quote?.totals;

        if (!totals || totals.cycle === "onetime") {
            continue;
        }

        const group = recurring.find((row) => row.cycle === totals.cycle);

        if (group) {
            group.firstPeriodCents = add(
                group.firstPeriodCents,
                totals.firstPeriodCents,
            );
            group.renewalCents = add(group.renewalCents, totals.renewalCents);
        } else {
            recurring.push({
                cycle: totals.cycle,
                firstPeriodCents: totals.firstPeriodCents,
                renewalCents: totals.renewalCents,
            });
        }
    }

    const problems = entries
        .map((entry) => entry.problem)
        .filter((problem): problem is string => problem !== null);

    return {
        cart,
        entries,
        currency: cart.currency,
        itemCount: priced.length,
        dueTodayCents: add(
            ...priced.map((entry) => entry.quote?.totals.dueTodayCents ?? 0),
        ),
        setupCents: add(
            ...priced.map((entry) => entry.quote?.totals.setupCents ?? 0),
        ),
        recurring,
        problems,
        orderable: entries.length > 0 && problems.length === 0,
    };
}
