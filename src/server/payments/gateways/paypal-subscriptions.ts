import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { OPEN_INVOICE_STATUSES } from "@/db/schema";
import { toDecimalString } from "@/lib/money";
import { createId } from "@/lib/ulid";
import { applyPayment } from "@/server/payments/apply";
import { appUrl, gatewayConfig } from "@/server/payments/settings";
import { call, centsOf } from "./paypal-api";
import { GatewayError } from "./types";

/**
 * PayPal's own Subscriptions API — the fallback when the account has not been
 * approved for reference transactions and a stored wallet therefore cannot be
 * charged.
 *
 * The thing to hold on to while reading this: **PayPal runs the schedule here
 * and we still do not let it decide anything.** A PayPal plan exists only
 * because the API refuses to make a subscription without one; what a customer
 * owes, for which period, at which price, is still our catalog's answer, and
 * the invoice is still ours. All this mode changes is *who presses the
 * button* — and `PAYMENT.SALE.COMPLETED` is PayPal telling us it pressed it.
 *
 * That is why the mapping below applies the money to the customer's oldest
 * open invoice and lets the ordinary settlement arithmetic decide the rest:
 * short of what is owed is a partial payment, more than is owed becomes
 * credit, and an account with nothing open gets credit too. No heuristic
 * tries to guess which document PayPal "meant"; the money is simply booked
 * where our own books say it belongs.
 */

type Db = typeof defaultDb;

/** `MONTH`/`YEAR` and a count, as PayPal's billing cycle wants them. */
const CYCLES: Record<string, { unit: string; count: number }> = {
    monthly: { unit: "MONTH", count: 1 },
    quarterly: { unit: "MONTH", count: 3 },
    semiannually: { unit: "MONTH", count: 6 },
    annually: { unit: "YEAR", count: 1 },
    biennially: { unit: "YEAR", count: 2 },
    triennially: { unit: "YEAR", count: 3 },
};

/**
 * Everything that makes a plan a *different* plan. The price is part of it on
 * purpose: reusing a plan after a price change would reprice everybody
 * already on it, which is PayPal's behaviour and not ours.
 */
export function planKey(input: {
    cycle: string;
    unitAmountCents: number;
    currency: string;
    mode: string;
}): string {
    return [
        input.cycle,
        input.unitAmountCents,
        input.currency,
        input.mode,
    ].join(":");
}

export async function ensurePlan(
    db: Db,
    input: {
        cycle: string;
        unitAmountCents: number;
        currency: string;
        /** What the customer sees on PayPal's side. */
        name: string;
    },
): Promise<{ paypalPlanId: string; paypalProductId: string }> {
    const config = await gatewayConfig("paypal");
    const cycle = CYCLES[input.cycle];

    if (!cycle) {
        throw new GatewayError(
            "paypal",
            `PayPal kennt den Abrechnungsrhythmus „${input.cycle}“ nicht.`,
            "unsupported_cycle",
        );
    }

    const key = planKey({ ...input, mode: config.mode });

    const [known] = await db
        .select()
        .from(schema.paypalPlan)
        .where(eq(schema.paypalPlan.planKey, key));

    if (known) {
        return {
            paypalPlanId: known.paypalPlanId,
            paypalProductId: known.paypalProductId,
        };
    }

    const product = await call<{ id: string }>("/v1/catalogs/products", {
        method: "POST",
        // Deterministic, so a retry after a lost response finds the product
        // PayPal already made rather than making a second one.
        requestId: `product:${key}`,
        body: {
            name: input.name,
            type: "SERVICE",
            category: "SOFTWARE",
        },
    });

    const plan = await call<{ id: string }>("/v1/billing/plans", {
        method: "POST",
        requestId: `plan:${key}`,
        body: {
            product_id: product.id,
            name: `${input.name} (${input.cycle})`,
            status: "ACTIVE",
            billing_cycles: [
                {
                    frequency: {
                        interval_unit: cycle.unit,
                        interval_count: cycle.count,
                    },
                    tenure_type: "REGULAR",
                    sequence: 1,
                    // 0 = until it is cancelled. Our engine decides when that
                    // is; PayPal is not given an end date it could enforce.
                    total_cycles: 0,
                    pricing_scheme: {
                        fixed_price: {
                            value: toDecimalString(input.unitAmountCents),
                            currency_code: input.currency,
                        },
                    },
                },
            ],
            payment_preferences: {
                auto_bill_outstanding: true,
                setup_fee_failure_action: "CONTINUE",
                payment_failure_threshold: 1,
            },
            // § 19 UStG: no tax line anywhere, including at PayPal.
            taxes: { percentage: "0", inclusive: false },
        },
    });

    await db
        .insert(schema.paypalPlan)
        .values({
            id: createId("paypalplan"),
            planKey: key,
            paypalProductId: product.id,
            paypalPlanId: plan.id,
        })
        .onConflictDoNothing();

    return { paypalPlanId: plan.id, paypalProductId: product.id };
}

/**
 * Starts a PayPal-run subscription and records its reference on ours. The
 * customer still has to approve it, which is what the returned URL is for.
 */
export async function createGatewaySubscription(
    db: Db,
    input: {
        subscriptionId: string;
        customerId: string;
        customerEmail: string;
        planId: string;
        startAt?: Date | null;
    },
): Promise<{ ref: string; url: string }> {
    const created = await call<{
        id: string;
        links?: { rel: string; href: string }[];
    }>("/v1/billing/subscriptions", {
        method: "POST",
        requestId: `subscription:${input.subscriptionId}`,
        body: {
            plan_id: input.planId,
            custom_id: input.subscriptionId,
            subscriber: { email_address: input.customerEmail },
            ...(input.startAt
                ? { start_time: input.startAt.toISOString() }
                : {}),
            application_context: {
                brand_name: "virtify.net",
                locale: "de-DE",
                user_action: "SUBSCRIBE_NOW",
                return_url: `${appUrl()}/client/contracts?provider=paypal`,
                cancel_url: `${appUrl()}/client/contracts`,
            },
        },
    });

    const approve = created.links?.find((link) => link.rel === "approve");

    if (!approve) {
        throw new GatewayError("paypal", "PayPal lieferte keine Adresse.");
    }

    await db
        .update(schema.subscription)
        .set({
            gateway: "paypal",
            gatewaySubscriptionRef: created.id,
            updatedAt: new Date(),
        })
        .where(eq(schema.subscription.id, input.subscriptionId));

    return { ref: created.id, url: approve.href };
}

export async function cancelGatewaySubscription(
    ref: string,
    reason = "Vom Kunden gekündigt",
): Promise<void> {
    await call(`/v1/billing/subscriptions/${ref}/cancel`, {
        method: "POST",
        body: { reason },
    });
}

export type SubscriptionSale = {
    /** The PayPal subscription the money came from. */
    billingAgreementId: string;
    /** The sale's own id — the idempotency key for the payment. */
    saleId: string;
    amountCents: number;
    feeCents: number | null;
    currency: string;
};

/** Pulls a `PAYMENT.SALE.COMPLETED` resource apart, with no float anywhere. */
export function readSale(resource: {
    id?: string;
    billing_agreement_id?: string;
    amount?: { total?: string; currency?: string };
    transaction_fee?: { value?: string };
}): SubscriptionSale | null {
    const amountCents = centsOf(resource.amount?.total);

    if (
        !resource.id ||
        !resource.billing_agreement_id ||
        amountCents === null
    ) {
        return null;
    }

    return {
        billingAgreementId: resource.billing_agreement_id,
        saleId: resource.id,
        amountCents,
        feeCents: centsOf(resource.transaction_fee?.value),
        currency: resource.amount?.currency ?? "EUR",
    };
}

export type SaleMapping =
    | { matched: false }
    | {
          matched: true;
          subscriptionId: string;
          customerId: string;
          /** Null when the account had nothing open and it became credit. */
          invoiceId: string | null;
      };

/**
 * Books a PayPal-run collection against our books.
 *
 * It never invents a document and never picks by amount: the subscription
 * names the customer, the customer's oldest open invoice takes the money, and
 * the settlement arithmetic does the rest. With nothing open, the money
 * becomes credit — which is the one outcome that can never be wrong, because
 * the money did arrive.
 */
export async function mapSubscriptionSale(
    db: Db,
    sale: SubscriptionSale,
): Promise<SaleMapping> {
    const [subscription] = await db
        .select({
            id: schema.subscription.id,
            customerId: schema.subscription.customerId,
        })
        .from(schema.subscription)
        .where(
            and(
                eq(schema.subscription.gateway, "paypal"),
                eq(
                    schema.subscription.gatewaySubscriptionRef,
                    sale.billingAgreementId,
                ),
            ),
        );

    if (!subscription) {
        return { matched: false };
    }

    const [open] = await db
        .select({ id: schema.invoice.id })
        .from(schema.invoice)
        .where(
            and(
                eq(schema.invoice.customerId, subscription.customerId),
                inArray(schema.invoice.status, [...OPEN_INVOICE_STATUSES]),
            ),
        )
        // Oldest first, and the ULID is the creation order, so this is
        // deterministic without a second column to sort on.
        .orderBy(asc(schema.invoice.id))
        .limit(1);

    const outcome = await applyPayment(db, {
        ref: sale.saleId,
        gateway: "paypal",
        invoiceId: open?.id ?? null,
        customerId: subscription.customerId,
        amountCents: sale.amountCents,
        feeCents: sale.feeCents,
        purpose: open ? "invoice" : "topup",
        note: `PayPal-Abo ${sale.billingAgreementId}`,
        actor: { type: "system", label: "paypal" },
    });

    return {
        matched: outcome.known,
        subscriptionId: subscription.id,
        customerId: subscription.customerId,
        invoiceId: outcome.invoiceId,
    } as SaleMapping;
}
