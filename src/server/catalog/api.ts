import { z } from "zod";
import type {
    ConfigOptionPricing,
    Product,
    ProductGroup,
    ProductPricing,
} from "@/db/schema/catalog";
import type { Quote } from "@/server/billing/pricing";
import type { ProductDetail } from "@/server/catalog/repository";

/**
 * The translation between the API's wire shape and the service's. The API is
 * snake_case because that is what the specification says; the rows are
 * camelCase because that is what Drizzle produces. Doing it here once keeps
 * the difference out of both.
 *
 * `module_config` is deliberately not on the wire. It is the operator's
 * configuration of a provisioning module — template ids, node names — and
 * says nothing a buyer needs in order to decide or to order.
 */

function serializePricing(row: ProductPricing) {
    return {
        cycle: row.cycle,
        currency: row.currency,
        price_cents: row.priceCents,
        setup_fee_cents: row.setupFeeCents,
        trial_days: row.trialDays,
    };
}

function serializeOptionPricing(row: ConfigOptionPricing) {
    return {
        cycle: row.cycle,
        currency: row.currency,
        price_cents: row.priceCents,
        setup_fee_cents: row.setupFeeCents,
    };
}

export function serializeProduct(
    product: Product,
    group: ProductGroup,
    pricing: ProductPricing[],
) {
    return {
        id: product.id,
        slug: product.slug,
        name: product.name,
        type: product.type,
        status: product.status,
        tagline: product.tagline,
        description: product.description,
        module: product.module,
        max_quantity: product.maxQuantity,
        group: {
            id: group.id,
            slug: group.slug,
            name: group.name,
        },
        pricing: pricing.map(serializePricing),
        created_at: product.createdAt.toISOString(),
        updated_at: product.updatedAt.toISOString(),
    };
}

export function serializeProductDetail(detail: ProductDetail) {
    return {
        ...serializeProduct(detail.product, detail.group, detail.pricing),
        config_options: detail.options.map(({ option, values }) => ({
            id: option.id,
            name: option.name,
            description: option.description,
            type: option.type,
            required: option.required,
            min_quantity: option.minQuantity,
            max_quantity: option.maxQuantity,
            values: values.map(({ value, pricing }) => ({
                id: value.id,
                name: value.name,
                is_default: value.isDefault,
                pricing: pricing.map(serializeOptionPricing),
            })),
        })),
    };
}

export function serializeQuote(quote: Quote) {
    return {
        product_id: quote.productId,
        product_name: quote.productName,
        lines: quote.lines.map((line) => ({
            kind: line.kind,
            label: line.label,
            detail: line.detail ?? null,
            quantity: line.quantity,
            unit_amount_cents: line.unitAmountCents,
            amount_cents: line.amountCents,
            recurring: line.recurring,
            option_id: line.optionId ?? null,
            value_id: line.valueId ?? null,
        })),
        totals: {
            currency: quote.totals.currency,
            cycle: quote.totals.cycle,
            recurring_gross_cents: quote.totals.recurringGrossCents,
            recurring_discount_cents: quote.totals.recurringDiscountCents,
            first_period_cents: quote.totals.firstPeriodCents,
            renewal_cents: quote.totals.renewalCents,
            setup_gross_cents: quote.totals.setupGrossCents,
            setup_discount_cents: quote.totals.setupDiscountCents,
            setup_cents: quote.totals.setupCents,
            due_today_cents: quote.totals.dueTodayCents,
            trial_days: quote.totals.trialDays,
            first_charge_at: quote.totals.firstChargeAt?.toISOString() ?? null,
            discount_periods: quote.totals.discountPeriods,
        },
        coupon: quote.coupon,
        coupon_error: quote.couponError,
    };
}

export const productListQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().optional(),
    group: z.string().optional(),
    type: z
        .enum([
            "vps",
            "webhosting",
            "gameserver",
            "domain",
            "subscription",
            "other",
        ])
        .optional(),
});

/**
 * The quote body, as the wire spells it. Mapped onto the service's shape
 * rather than parsed into it directly, so the one definition of what a quote
 * request may be stays in `@/server/catalog/schema`.
 */
export const quoteBodySchema = z.object({
    cycle: z.enum([
        "monthly",
        "quarterly",
        "semiannual",
        "annual",
        "biennial",
        "onetime",
    ]),
    currency: z.string().trim().toUpperCase().default("EUR"),
    quantity: z.number().int().min(1).max(999).default(1),
    options: z
        .array(
            z.object({
                option_id: z.string().trim().min(1),
                value_id: z.string().trim().min(1),
                quantity: z.number().int().min(0).max(9999).default(1),
            }),
        )
        .default([]),
    coupon_code: z.string().trim().max(40).nullable().default(null),
});

export type QuoteBody = z.infer<typeof quoteBodySchema>;

export function quoteFromWire(body: QuoteBody) {
    return {
        cycle: body.cycle,
        currency: body.currency,
        quantity: body.quantity,
        options: body.options.map((entry) => ({
            optionId: entry.option_id,
            valueId: entry.value_id,
            quantity: entry.quantity,
        })),
        couponCode: body.coupon_code,
    };
}
