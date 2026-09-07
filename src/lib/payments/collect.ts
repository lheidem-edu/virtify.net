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
    markProcessing,
    notifyCollectionFailed,
    recordAttempt,
    settlePayment,
} from "@/lib/payments/settle";
import {
    confirmStoredCharge,
    prepareStoredCharge,
    stripe,
} from "@/lib/payments/stripe";

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
 * Closes the checkouts an invoice has left open before a new one is started.
 * Two live sessions for one invoice are two ways to pay it, and the customer
 * with an old tab open would pay twice through no fault of their own.
 */
export async function closeOpenAttempts(invoiceId: string) {
    const open = await db
        .select({
            id: schema.payment.id,
            provider: schema.payment.provider,
            providerRef: schema.payment.providerRef,
        })
        .from(schema.payment)
        .where(
            and(
                eq(schema.payment.invoiceId, invoiceId),
                eq(schema.payment.status, "pending"),
            ),
        );

    for (const attempt of open) {
        try {
            // Only Stripe can be told to close a session; a PayPal order the
            // customer never approved simply expires, and capturing one needs
            // an approval it will never get.
            if (
                attempt.provider === "stripe" &&
                attempt.providerRef.startsWith("cs_")
            ) {
                await stripe().checkout.sessions.expire(attempt.providerRef);
            }
        } catch (error) {
            // Already expired, already paid, or gone — either way the row
            // below is what stops us offering it again.
            console.error(
                "[payments] expiring the old checkout failed:",
                error,
            );
        }

        await failPayment({
            provider: attempt.provider,
            providerRef: attempt.providerRef,
            code: "superseded",
            message: "Durch einen neuen Zahlungsvorgang ersetzt.",
        });
    }
}

/**
 * Settles a Stripe checkout the customer has just come back from. The webhook
 * is the authority and will do this too — this only spares the customer a page
 * that still says "offen" about money they just handed over.
 *
 * The session id arrives in a URL the customer could edit, so it is trusted
 * for nothing: the session's own metadata has to name the invoice the route is
 * about, and settlePayment then only recognises an attempt we recorded
 * ourselves.
 */
export async function settleCheckoutReturn(
    sessionId: string,
    invoiceId: string,
) {
    const session = await stripe().checkout.sessions.retrieve(sessionId);

    if (session.metadata?.invoice_id !== invoiceId) {
        return false;
    }

    if (session.payment_status === "unpaid") {
        return false;
    }

    const intentId =
        typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

    const outcome = await settlePayment({
        provider: "stripe",
        providerRef: session.id,
        captureRef: intentId,
    });

    return outcome.known;
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

            const prepared = await prepareStoredCharge({
                invoiceId,
                invoiceNumber: row.number,
                amountCents,
                stripeCustomerId: row.stripeCustomerId,
                token: row.token,
            });

            // Written down before the money moves. The attempt is keyed on the
            // PaymentIntent, which is also what the webhook will carry — there
            // is no checkout session in this flow.
            await recordAttempt({
                invoiceId,
                userId: row.userId,
                provider: "stripe",
                providerRef: prepared.id,
                amountCents,
                paymentMethodId: row.methodId,
            });

            const intent = await confirmStoredCharge(prepared.id);

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

        // PENDING is not a refusal — PayPal is still working on it and will
        // say so by webhook. Reporting it as failed would tell the operator
        // the money did not come, and the notice would promise no retry while
        // PayPal quietly settles it anyway.
        if (capture.captureStatus === "PENDING") {
            await markProcessing({
                provider: "paypal",
                providerRef: capture.orderId,
            });

            return { attempted: true as const, pending: true as const };
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
