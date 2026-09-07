import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { paypalConfig } from "@/lib/payments/config";
import {
    captureOrder,
    chargeVaultToken,
    paypalIssue,
    readOrder,
} from "@/lib/payments/paypal";
import {
    failPayment,
    notifyCollectionFailed,
    recordAttempt,
    settlePayment,
} from "@/lib/payments/settle";
import { chargeStoredMethod } from "@/lib/payments/stripe";

/**
 * Taking the money, from both directions: the customer who approved a PayPal
 * order, and the contract that collects itself when an invoice is issued.
 */

/**
 * Captures an approved PayPal order and settles it. Both the customer's
 * return and the webhook end up here, possibly at the same moment — PayPal
 * answers the loser ORDER_ALREADY_CAPTURED, which is a success, not a fault.
 */
export async function captureAndSettle(orderId: string) {
    let capture: Awaited<ReturnType<typeof captureOrder>>;

    try {
        capture = await captureOrder(orderId);
    } catch (error) {
        if (paypalIssue(error) !== "ORDER_ALREADY_CAPTURED") {
            throw error;
        }

        capture = await readOrder(orderId);
    }

    if (capture.captureStatus !== "COMPLETED") {
        await failPayment({
            provider: "paypal",
            providerRef: orderId,
            code: capture.captureStatus ?? capture.status,
        });

        return false;
    }

    await settlePayment({
        provider: "paypal",
        providerRef: orderId,
        captureRef: capture.captureId,
        feeCents: capture.feeCents,
    });

    return true;
}

/**
 * Collects a freshly issued invoice from the payment method its contract has
 * stored. Runs after the invoice is committed and never rolls it back: a
 * failed collection leaves an ordinary open invoice, which is exactly what it
 * is. Nothing is retried automatically — the operator decides, as they asked.
 */
export async function collectIssuedInvoice(invoiceId: string) {
    const [row] = await db
        .select({
            invoiceId: schema.invoice.id,
            number: schema.invoice.number,
            userId: schema.invoice.userId,
            email: schema.user.email,
            stripeCustomerId: schema.user.stripeCustomerId,
            methodId: schema.paymentMethod.id,
            provider: schema.paymentMethod.provider,
            token: schema.paymentMethod.token,
        })
        .from(schema.invoice)
        .innerJoin(
            schema.contract,
            eq(schema.invoice.contractId, schema.contract.id),
        )
        .innerJoin(
            schema.paymentMethod,
            eq(schema.contract.paymentMethodId, schema.paymentMethod.id),
        )
        .innerJoin(schema.user, eq(schema.invoice.userId, schema.user.id))
        .where(
            and(
                eq(schema.invoice.id, invoiceId),
                eq(schema.invoice.status, "issued"),
                isNull(schema.paymentMethod.revokedAt),
            ),
        );

    if (!row?.number) {
        return { attempted: false as const };
    }

    const amountCents = await invoiceTotal(invoiceId);

    if (amountCents <= 0) {
        return { attempted: false as const };
    }

    try {
        if (row.provider === "stripe") {
            if (!row.stripeCustomerId) {
                throw new Error("no stripe customer for a stored method");
            }

            const intent = await chargeStoredMethod({
                invoiceId,
                invoiceNumber: row.number,
                amountCents,
                stripeCustomerId: row.stripeCustomerId,
                token: row.token,
            });

            // The attempt is keyed on the PaymentIntent, which is also what
            // the webhook will carry — there is no session in this flow.
            await recordAttempt({
                invoiceId,
                userId: row.userId,
                provider: "stripe",
                providerRef: intent.id,
                amountCents,
                paymentMethodId: row.methodId,
            });

            if (intent.status === "succeeded") {
                await settlePayment({
                    provider: "stripe",
                    providerRef: intent.id,
                    captureRef: intent.id,
                });
            }

            return {
                attempted: true as const,
                succeeded: intent.status === "succeeded",
            };
        }

        if (!paypalConfig.vaulting) {
            throw new Error("paypal vaulting is switched off");
        }

        const capture = await chargeVaultToken({
            invoiceId,
            invoiceNumber: row.number,
            amountCents,
            token: row.token,
        });

        await recordAttempt({
            invoiceId,
            userId: row.userId,
            provider: "paypal",
            providerRef: capture.orderId,
            amountCents,
            paymentMethodId: row.methodId,
        });

        if (capture.captureStatus === "COMPLETED") {
            await settlePayment({
                provider: "paypal",
                providerRef: capture.orderId,
                captureRef: capture.captureId,
                feeCents: capture.feeCents,
            });

            return { attempted: true as const, succeeded: true };
        }

        throw new Error(capture.captureStatus ?? capture.status);
    } catch (error) {
        const reason =
            paypalIssue(error) ??
            (error instanceof Error ? error.message : "unbekannt");

        console.error("[payments] collecting the invoice failed:", error);

        await notifyCollectionFailed({
            invoiceNumber: row.number,
            customerEmail: row.email,
            amountCents,
            reason,
        });

        return { attempted: true as const, succeeded: false, reason };
    }
}

/** The invoice's own arithmetic, not the provider's. */
async function invoiceTotal(invoiceId: string) {
    const items = await db
        .select({
            quantity: schema.invoiceItem.quantity,
            unitPriceCents: schema.invoiceItem.unitPriceCents,
        })
        .from(schema.invoiceItem)
        .where(eq(schema.invoiceItem.invoiceId, invoiceId));

    return items.reduce(
        (sum, item) => sum + Math.round(item.quantity * item.unitPriceCents),
        0,
    );
}
