import "server-only";
import { z } from "zod";
import type { Order, OrderItem } from "@/db/schema";
import { zId } from "@/lib/ulid";
import { billingCycleSchema, currencySchema } from "@/server/catalog/schema";
import type { LoadedOrder } from "@/server/orders/repository";
import type { OrderItemRequest } from "@/server/orders/service";

/**
 * What an order looks like from outside: snake_case, cents as integers,
 * instants as ISO-8601 in UTC. Kept beside the service rather than in the
 * route, so the API, the tests and anything else that has to speak the wire
 * shape agree on one definition of it.
 */

export const orderCreateBodySchema = z.object({
    /**
     * Staff keys only. A customer key always orders for its own account and
     * this field is ignored rather than honoured — the same rule the invoice
     * endpoints follow.
     */
    customer_id: zId("customer").nullish(),
    items: z
        .array(
            z.object({
                product_id: z.string().trim().min(1),
                cycle: billingCycleSchema,
                currency: currencySchema.default("EUR"),
                quantity: z.number().int().min(1).max(999).default(1),
                options: z
                    .array(
                        z.object({
                            option_id: z.string().trim().min(1),
                            value_id: z.string().trim().min(1),
                            quantity: z
                                .number()
                                .int()
                                .min(0)
                                .max(9999)
                                .default(1),
                        }),
                    )
                    .default([]),
                coupon_code: z.string().trim().max(40).nullish(),
            }),
        )
        .min(1)
        .max(50),
    /** Only `bank_transfer` is settled today; Stripe and PayPal are Phase 5. */
    payment_option: z.enum(["bank_transfer"]).default("bank_transfer"),
    auto_charge: z.boolean().default(false),
    accept_terms: z.boolean().default(false),
    accept_withdrawal: z.boolean().default(false),
    request_immediate_start: z.boolean().default(false),
    note: z.string().trim().max(2000).nullish(),
});

export type OrderCreateBody = z.infer<typeof orderCreateBodySchema>;

export function orderItemsFromWire(body: OrderCreateBody): OrderItemRequest[] {
    return body.items.map((item) => ({
        productId: item.product_id,
        cycle: item.cycle,
        currency: item.currency,
        quantity: item.quantity,
        options: item.options.map((option) => ({
            optionId: option.option_id,
            valueId: option.value_id,
            quantity: option.quantity,
        })),
        couponCode: item.coupon_code ?? null,
    }));
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

function serializeOrderItem(item: OrderItem) {
    return {
        id: item.id,
        position: item.position,
        product_id: item.productId,
        description: item.description,
        cycle: item.cycle,
        currency: item.currency,
        quantity: item.quantity,
        unit_price_cents: item.unitPriceCents,
        setup_fee_cents: item.setupFeeCents,
        trial_days: item.trialDays,
        recurring_gross_cents: item.recurringGrossCents,
        recurring_discount_cents: item.recurringDiscountCents,
        first_period_cents: item.firstPeriodCents,
        renewal_cents: item.renewalCents,
        setup_cents: item.setupCents,
        due_today_cents: item.dueTodayCents,
        coupon_code: item.couponCode,
        discount_periods: item.discountPeriods,
    };
}

export function serializeOrder(loaded: LoadedOrder) {
    const { order } = loaded;

    return {
        id: order.id,
        number: order.number,
        status: order.status,
        customer_id: order.customerId,
        currency: order.currency,
        net_cents: order.netCents,
        tax_cents: order.taxCents,
        gross_cents: order.grossCents,
        payment_option: order.paymentOption,
        auto_charge: order.autoCharge,
        invoice_id: order.invoiceId,
        invoice_number: loaded.invoice?.number ?? null,
        terms_version: order.termsVersion,
        terms_label: order.termsLabel,
        terms_accepted_at: iso(order.termsAcceptedAt),
        withdrawal_accepted_at: iso(order.withdrawalAcceptedAt),
        is_consumer: order.isConsumer,
        placed_at: iso(order.placedAt),
        accepted_at: iso(order.acceptedAt),
        cancelled_at: iso(order.cancelledAt),
        items: loaded.items.map(serializeOrderItem),
        subscriptions: loaded.subscriptions.map(({ subscription, items }) => ({
            id: subscription.id,
            status: subscription.status,
            cycle: subscription.cycle,
            currency: subscription.currency,
            current_period_start: iso(subscription.currentPeriodStart),
            current_period_end: iso(subscription.currentPeriodEnd),
            next_billing_at: iso(subscription.nextBillingAt),
            trial_ends_at: iso(subscription.trialEndsAt),
            auto_charge: subscription.autoCharge,
            items: items.map((item) => ({
                id: item.id,
                product_id: item.productId,
                description: item.description,
                quantity: item.quantity,
                unit_price_cents: item.unitPriceCents,
                recurring_gross_cents: item.recurringGrossCents,
            })),
        })),
        services: loaded.services.map((service) => ({
            id: service.id,
            status: service.status,
            label: service.label,
            product_id: service.productId,
            subscription_item_id: service.subscriptionItemId,
        })),
    };
}

export type SerializedOrder = ReturnType<typeof serializeOrder>;

export const orderListQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(["pending", "active", "cancelled", "fraud"]).optional(),
});

export type OrderRow = Order;
