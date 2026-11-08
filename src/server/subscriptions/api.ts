import "server-only";
import { z } from "zod";
import type { Service, SubscriptionItem } from "@/db/schema";
import { zId } from "@/lib/ulid";
import { billingCycleSchema, currencySchema } from "@/server/catalog/schema";
import type { ChangePreview } from "@/server/subscriptions/changes";
import type {
    LoadedSubscription,
    SubscriptionListRow,
} from "@/server/subscriptions/repository";

/**
 * What an Abo looks like from outside: snake_case, cents as integers,
 * instants as ISO-8601 in UTC.
 *
 * Beside the service rather than in the route, so the API, the tests and
 * anything else that has to speak the wire shape agree on one definition of
 * it — the same arrangement `src/server/orders/api.ts` uses.
 */

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

// --- requests --------------------------------------------------------------

export const subscriptionCreateBodySchema = z.object({
    customer_id: zId("customer").nullish(),
    items: z
        .array(
            z.object({
                product_id: z.string().trim().min(1),
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
            }),
        )
        .min(1)
        .max(50),
    cycle: billingCycleSchema,
    currency: currencySchema.default("EUR"),
    coupon_code: z.string().trim().max(40).nullish(),
    auto_charge: z.boolean().default(false),
    accept_terms: z.boolean().default(false),
    accept_withdrawal: z.boolean().default(false),
    request_immediate_start: z.boolean().default(false),
    note: z.string().trim().max(2000).nullish(),
});

export type SubscriptionCreateBody = z.infer<
    typeof subscriptionCreateBodySchema
>;

export const cancelBodySchema = z.object({
    when: z.enum(["now", "period_end"]).default("period_end"),
    reason: z.string().trim().max(500).nullish(),
});

export const pauseBodySchema = z.object({
    reason: z.string().trim().max(500).nullish(),
});

export const resumeBodySchema = z.object({
    /**
     * `paused` takes a paused Abo back into service; `cancellation`
     * withdraws a cancellation that was set for the end of the period.
     * Defaults to whichever applies — they cannot both.
     */
    what: z.enum(["auto", "paused", "cancellation"]).default("auto"),
});

const changeFields = {
    item_id: zId("subscriptionitem"),
    product_id: z.string().trim().min(1).nullish(),
    quantity: z.number().int().min(1).max(999).nullish(),
    options: z
        .array(
            z.object({
                option_id: z.string().trim().min(1),
                value_id: z.string().trim().min(1),
                quantity: z.number().int().min(0).max(9999).default(1),
            }),
        )
        .nullish(),
    effective: z.enum(["immediately", "period_end"]).default("immediately"),
};

export const changeBodySchema = z.object(changeFields);

/**
 * The preview takes the same fields in the query string, because it is a
 * GET: it changes nothing and a client should be able to show the price
 * without a body. `option` may repeat, as `optionId:valueId:quantity`.
 */
export const previewQuerySchema = z.object({
    item_id: z.string().trim().min(1),
    product_id: z.string().trim().min(1).nullish(),
    quantity: z.coerce.number().int().min(1).max(999).nullish(),
    option: z.array(z.string()).default([]),
    effective: z.enum(["immediately", "period_end"]).default("immediately"),
});

/** `optionId:valueId:quantity` → the shape the change service takes. */
export function optionsFromQuery(
    values: string[],
): { optionId: string; valueId: string; quantity: number }[] | null {
    if (values.length === 0) {
        return null;
    }

    return values.map((entry) => {
        const [optionId, valueId, quantity] = entry.split(":");

        if (!optionId || !valueId) {
            throw new Error(
                `„${entry}“ ist keine Option. Erwartet wird optionId:valueId:menge.`,
            );
        }

        return {
            optionId,
            valueId,
            quantity: quantity === undefined ? 1 : Number(quantity),
        };
    });
}

// --- responses -------------------------------------------------------------

function serializeService(service: Service) {
    return {
        id: service.id,
        status: service.status,
        label: service.label,
        module: service.module,
        activated_at: iso(service.activatedAt),
        suspended_at: iso(service.suspendedAt),
        terminated_at: iso(service.terminatedAt),
    };
}

function serializeItem(item: SubscriptionItem & { services?: Service[] }) {
    return {
        id: item.id,
        position: item.position,
        product_id: item.productId,
        description: item.description,
        quantity: item.quantity,
        unit_price_cents: item.unitPriceCents,
        recurring_gross_cents: item.recurringGrossCents,
        selections: item.selections,
        services: (item.services ?? []).map(serializeService),
    };
}

export function serializeSubscriptionRow(row: SubscriptionListRow) {
    return {
        id: row.id,
        status: row.status,
        cycle: row.cycle,
        currency: row.currency,
        label: row.label,
        period_gross_cents: row.periodGrossCents,
        current_period_start: iso(row.currentPeriodStart),
        current_period_end: iso(row.currentPeriodEnd),
        next_billing_at: iso(row.nextBillingAt),
        trial_ends_at: iso(row.trialEndsAt),
        cancel_at_period_end: row.cancelAtPeriodEnd,
        auto_charge: row.autoCharge,
        customer_id: row.customerId,
    };
}

export function serializeSubscription(loaded: LoadedSubscription) {
    const { subscription } = loaded;

    return {
        id: subscription.id,
        status: subscription.status,
        cycle: subscription.cycle,
        currency: subscription.currency,
        customer_id: subscription.customerId,
        order_id: subscription.orderId,
        current_period_start: iso(subscription.currentPeriodStart),
        current_period_end: iso(subscription.currentPeriodEnd),
        next_billing_at: iso(subscription.nextBillingAt),
        trial_ends_at: iso(subscription.trialEndsAt),
        cancel_at_period_end: subscription.cancelAtPeriodEnd,
        auto_charge: subscription.autoCharge,
        payment_method_id: subscription.paymentMethodId,
        coupon_code: subscription.couponCode,
        discount_periods_remaining: subscription.discountPeriodsRemaining,
        period_gross_cents: loaded.items.reduce(
            (total, item) => total + item.recurringGrossCents,
            0,
        ),
        started_at: iso(subscription.startedAt),
        paused_at: iso(subscription.pausedAt),
        past_due_at: iso(subscription.pastDueAt),
        cancelled_at: iso(subscription.cancelledAt),
        ended_at: iso(subscription.endedAt),
        items: loaded.items.map(serializeItem),
        invoices: loaded.invoices.map((invoice) => ({
            id: invoice.id,
            number: invoice.number,
            status: invoice.status,
            kind: invoice.kind,
            gross_cents: invoice.grossCents,
            paid_cents: invoice.paidCents,
            due_at: iso(invoice.dueAt),
            issued_at: iso(invoice.issuedAt),
            period_start: iso(invoice.periodStart),
            period_end: iso(invoice.periodEnd),
        })),
        events: loaded.events.map((event) => ({
            id: event.id,
            kind: event.kind,
            from_status: event.fromStatus,
            to_status: event.toStatus,
            summary: event.summary,
            at: iso(event.at),
        })),
        pending_changes: loaded.pendingChanges.map((change) => ({
            id: change.id,
            direction: change.direction,
            effective: change.effective,
            product_id: change.productId,
            description: change.description,
            quantity: change.quantity,
            recurring_gross_cents: change.recurringGrossCents,
            apply_at: iso(change.applyAt),
        })),
    };
}

export function serializePreview(preview: ChangePreview) {
    return {
        subscription_id: preview.subscriptionId,
        item_id: preview.itemId,
        currency: preview.currency,
        cycle: preview.cycle,
        effective: preview.effective,
        apply_at: iso(preview.applyAt),
        direction: preview.proration.direction,
        current: {
            product_id: preview.current.productId,
            description: preview.current.description,
            quantity: preview.current.quantity,
            unit_price_cents: preview.current.unitPriceCents,
            recurring_gross_cents: preview.current.recurringGrossCents,
        },
        next: {
            product_id: preview.next.productId,
            description: preview.next.description,
            quantity: preview.next.quantity,
            unit_price_cents: preview.next.unitPriceCents,
            recurring_gross_cents: preview.next.recurringGrossCents,
        },
        proration: {
            remaining_days: preview.proration.remainingDays,
            period_days: preview.proration.periodDays,
            unused_credit_cents: preview.proration.unusedCreditCents,
            new_charge_cents: preview.proration.newChargeCents,
            difference_cents: preview.proration.differenceCents,
        },
        invoice_today_cents: preview.invoiceTodayCents,
        credit_today_cents: preview.creditTodayCents,
        current_period_cents: preview.currentPeriodCents,
        next_period_cents: preview.nextPeriodCents,
        label: preview.label,
    };
}
