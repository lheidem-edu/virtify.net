import "server-only";
import type Stripe from "stripe";
import { type db as defaultDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { applyPayment } from "@/server/payments/apply";
import {
    disputeStatusFromStripe,
    recordDispute,
} from "@/server/payments/disputes";
import { claimSetup, storeMethod } from "@/server/payments/methods";
import { recordReversal } from "@/server/payments/refunds";
import {
    emitInvoicePaid,
    failPayment,
    markProcessing,
    notifyDispute,
    notifyReversal,
    notifyUnmatchedPayment,
} from "@/server/payments/settle";
import { gatewayConfig } from "@/server/payments/settings";
import { claimEvent } from "@/server/payments/webhook-log";
import type { WebhookOutcome } from "./types";
import { readFeeCents, readStoredMethod, stripeClient } from "./stripe";

/**
 * Stripe's word on whether money moved.
 *
 * The signature is computed over the exact bytes that arrived, so the body is
 * read as text and never parsed first — `request.json()` here breaks
 * verification with an error that does not say why.
 *
 * **The signature check is this route's authorization.** Nothing in the
 * payload is allowed to name the invoice it settles: every path below looks
 * up an attempt *we* recorded, by a reference *we* generated, and
 * `applyPayment` refuses anything it does not recognise. A verified payload
 * from Stripe about somebody else's integration would find no row and be
 * reported as unmatched rather than booked.
 *
 * Checkout holds the customer's redirect for up to ten seconds waiting for
 * this handler, so it does the least possible.
 */

type Db = typeof defaultDb;

export async function handleStripeWebhook(
    db: Db,
    request: Request,
): Promise<WebhookOutcome> {
    const config = await gatewayConfig("stripe");

    if (!config.credentials.secretKey || !config.credentials.webhookSecret) {
        throw new Error("stripe is not configured");
    }

    const signature = request.headers.get("stripe-signature");
    const body = await request.text();
    const stripe = await stripeClient();

    let event: Stripe.Event;

    try {
        event = stripe.webhooks.constructEvent(
            body,
            signature ?? "",
            config.credentials.webhookSecret,
        );
    } catch (error) {
        console.error("[payments] stripe signature rejected:", error);

        return { eventId: "", type: "", verified: false };
    }

    // Hard rule 7. The claim sits between the signature and the handler: a
    // delivery nobody has finished is handed over, one that is already
    // closed is not. A handler that throws leaves `handled_at` null, so
    // Stripe's own retry is a real retry rather than a silent 200.
    if (
        !(await claimEvent(db, {
            id: event.id,
            provider: "stripe",
            type: event.type,
        }))
    ) {
        return {
            eventId: event.id,
            type: event.type,
            verified: true,
            duplicate: true,
        };
    }

    const invoiceId = await handle(db, event);

    return {
        eventId: event.id,
        type: event.type,
        invoiceId,
        verified: true,
    };
}

async function handle(db: Db, event: Stripe.Event): Promise<string | null> {
    switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
            const session = event.data.object;

            /**
             * A setup session stores a card; it moves no money and has no
             * invoice. The browser's return does this too — whichever
             * arrives first wins and the other is a no-op, because the token
             * is unique.
             *
             * It is handled here rather than on `setup_intent.succeeded`
             * because this event carries the session id, and the session id
             * is what the `payment_setup` row was written under *before* the
             * customer was redirected. Without that row nothing is stored,
             * which is what stops somebody claiming another account's setup.
             */
            if (session.mode === "setup") {
                await storeFromSetupSession(db, session);

                return null;
            }

            // A completed session is not automatically a paid one: methods
            // with delayed notification finish later, through the async event.
            if (session.payment_status === "unpaid") {
                await markProcessing({
                    provider: "stripe",
                    providerRef: session.id,
                });

                return null;
            }

            const intentId = idOf(session.payment_intent);

            const outcome = await applyPayment(db, {
                ref: session.id,
                gateway: "stripe",
                captureRef: intentId,
                // Stripe's own minor-unit integer. Never parsed from a float.
                amountCents: session.amount_total ?? undefined,
                feeCents: intentId ? await fee(intentId) : null,
                actor: { type: "system", label: "stripe" },
            });

            if (!outcome.known) {
                await notifyUnmatchedPayment({
                    provider: "stripe",
                    providerRef: session.id,
                    event: event.type,
                });

                return null;
            }

            await emitInvoicePaid(outcome);

            return outcome.invoiceId;
        }

        case "checkout.session.async_payment_failed":
        case "checkout.session.expired": {
            await failPayment({
                provider: "stripe",
                providerRef: event.data.object.id,
                code: event.type,
            });

            return null;
        }

        // The off-session collections have no session; they are keyed on the
        // PaymentIntent, which is what we stored as their reference.
        case "payment_intent.succeeded": {
            const intent = event.data.object;

            const outcome = await applyPayment(db, {
                ref: intent.id,
                gateway: "stripe",
                captureRef: intent.id,
                amountCents: intent.amount_received,
                feeCents: await fee(intent.id),
                actor: { type: "system", label: "stripe" },
            });

            if (!outcome.known) {
                await notifyUnmatchedPayment({
                    provider: "stripe",
                    providerRef: intent.id,
                    event: event.type,
                });

                return null;
            }

            await emitInvoicePaid(outcome);

            return outcome.invoiceId;
        }

        case "payment_intent.processing": {
            await markProcessing({
                provider: "stripe",
                providerRef: event.data.object.id,
            });

            return null;
        }

        case "payment_intent.payment_failed": {
            const intent = event.data.object;

            await failPayment({
                provider: "stripe",
                providerRef: intent.id,
                code: intent.last_payment_error?.code ?? null,
                message: intent.last_payment_error?.message ?? null,
            });

            return null;
        }

        /**
         * The authorisation itself succeeded. The card is stored from the
         * session event above, which is the one that knows which setup it
         * belongs to; this is here so the event is not silently ignored.
         */
        case "setup_intent.succeeded": {
            return null;
        }

        case "setup_intent.setup_failed": {
            console.error(
                "[payments] a stripe setup failed:",
                event.data.object.last_setup_error?.message,
            );

            return null;
        }

        // Money going back out. Every refund on the charge is recorded; the
        // refund id is the key, so the ones already booked are skipped.
        case "charge.refunded": {
            const charge = event.data.object;
            const intentId = idOf(charge.payment_intent);
            let invoiceId: string | null = null;

            for (const refund of charge.refunds?.data ?? []) {
                const result = await recordReversal(db, {
                    provider: "stripe",
                    captureRef: intentId,
                    refundRef: refund.id,
                    amountCents: refund.amount,
                    event: event.type,
                });

                if (result.ok && result.changed) {
                    await notifyReversal({
                        invoiceId: await invoiceOf(db, intentId),
                        amountCents: refund.amount,
                        event: event.type,
                    });
                }
            }

            invoiceId = await invoiceOf(db, intentId);

            return invoiceId;
        }

        case "charge.dispute.created":
        case "charge.dispute.updated":
        case "charge.dispute.closed": {
            const dispute = event.data.object;
            const intentId = idOf(dispute.payment_intent);

            const result = await recordDispute(db, {
                provider: "stripe",
                providerRef: dispute.id,
                captureRef: intentId,
                status: disputeStatusFromStripe(dispute.status),
                amountCents: dispute.amount,
                currency: dispute.currency.toUpperCase(),
                reason: dispute.reason ?? null,
                respondBy: dispute.evidence_details?.due_by
                    ? new Date(dispute.evidence_details.due_by * 1000)
                    : null,
            });

            if (!result.changed) {
                if (!result.invoiceId) {
                    await notifyUnmatchedPayment({
                        provider: "stripe",
                        providerRef: dispute.id,
                        event: event.type,
                    });
                }

                return result.invoiceId;
            }

            if (event.type === "charge.dispute.created") {
                await notifyDispute({
                    invoiceNumber:
                        (await invoiceNumberOf(db, result.invoiceId)) ?? "—",
                    amountCents: dispute.amount,
                    reason: dispute.reason ?? null,
                    respondBy: dispute.evidence_details?.due_by
                        ? new Date(dispute.evidence_details.due_by * 1000)
                        : null,
                });
            }

            return result.invoiceId;
        }

        default:
            return null;
    }
}

function idOf(value: string | { id: string } | null | undefined) {
    return typeof value === "string" ? value : (value?.id ?? null);
}

/**
 * The provider's cut is bookkeeping decoration. It costs another API call,
 * and that call must never be the reason a payment fails to settle.
 */
async function fee(paymentIntentId: string) {
    try {
        return await readFeeCents(paymentIntentId);
    } catch (error) {
        console.error("[payments] reading the stripe fee failed:", error);

        return null;
    }
}

async function invoiceOf(db: Db, captureRef: string | null) {
    if (!captureRef) {
        return null;
    }

    const [row] = await db
        .select({ invoiceId: schema.payment.invoiceId })
        .from(schema.payment)
        .where(eq(schema.payment.captureRef, captureRef));

    return row?.invoiceId ?? null;
}

async function invoiceNumberOf(db: Db, invoiceId: string | null) {
    if (!invoiceId) {
        return null;
    }

    const [row] = await db
        .select({ number: schema.invoice.number })
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId));

    return row?.number ?? null;
}

/**
 * Stores the method a finished setup session produced.
 *
 * Two independent checks, because the return URL is something anyone can
 * construct: the `payment_setup` row proves *we* started this session, and
 * the SetupIntent's own metadata has to name the same account. Only then is
 * a token written, and even then `storeMethod` refuses to move a token that
 * already belongs to somebody else.
 */
async function storeFromSetupSession(
    db: Db,
    session: Stripe.Checkout.Session,
): Promise<void> {
    const stored = await readStoredMethod(session.id);

    if (!stored?.customerId) {
        return;
    }

    const setup = await claimSetup(db, {
        id: session.id,
        customerId: stored.customerId,
        provider: "stripe",
    });

    if (!setup) {
        return;
    }

    await storeMethod(db, {
        customerId: stored.customerId,
        provider: "stripe",
        token: stored.token,
        label: stored.label,
        contractId: setup.contractId ?? stored.contractId,
        actor: { type: "system", label: "stripe" },
    });
}
