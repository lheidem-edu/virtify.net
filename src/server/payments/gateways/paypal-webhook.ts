import "server-only";
import { eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { applyPayment } from "@/server/payments/apply";
import { recordReversal } from "@/server/payments/refunds";
import { gatewayConfig } from "@/server/payments/settings";
import {
    emitInvoicePaid,
    failPayment,
    notifyReversal,
    notifyUnbookedReversal,
    notifyUnmatchedPayment,
} from "@/server/payments/settle";
import { claimEvent } from "@/server/payments/webhook-log";
import { captureApprovedOrder } from "./paypal";
import { centsOf, verifyWebhook } from "./paypal-api";
import { mapSubscriptionSale, readSale } from "./paypal-subscriptions";
import type { WebhookOutcome } from "./types";

/**
 * PayPal's word on whether money moved.
 *
 * There is no signing secret: the headers and the untouched body go back to
 * PayPal, which answers whether it sent them. The body therefore has to be
 * the exact string that arrived.
 *
 * As with Stripe, **the verification is this route's authorization**, and
 * nothing in the payload may name the invoice it settles. `custom_id` carries
 * our invoice id and is deliberately ignored: every path below finds an
 * attempt *we* recorded, under a reference *we* generated. The one exception
 * is the subscription mode, where PayPal drives the schedule — and there the
 * document is chosen by our own books (the customer's oldest open invoice),
 * not by anything the payload says.
 */

type Db = typeof defaultDb;

type Event = {
    id: string;
    event_type: string;
    resource?: {
        id?: string;
        status?: string;
        custom_id?: string;
        amount?: {
            value?: string;
            currency_code?: string;
            total?: string;
            currency?: string;
        };
        billing_agreement_id?: string;
        transaction_fee?: { value?: string };
        supplementary_data?: { related_ids?: { order_id?: string } };
        seller_receivable_breakdown?: { paypal_fee?: { value: string } };
    };
};

export async function handlePayPalWebhook(
    db: Db,
    request: Request,
): Promise<WebhookOutcome> {
    const config = await gatewayConfig("paypal");

    if (!config.credentials.clientId || !config.credentials.webhookId) {
        throw new Error("paypal is not configured");
    }

    const body = await request.text();

    if (!(await verifyWebhook({ headers: request.headers, rawBody: body }))) {
        return { eventId: "", type: "", verified: false };
    }

    const event = JSON.parse(body) as Event;

    // Hard rule 7 — see the Stripe handler for why this is a claim rather
    // than a plain "have we seen it".
    if (
        !(await claimEvent(db, {
            id: event.id,
            provider: "paypal",
            type: event.event_type,
        }))
    ) {
        return {
            eventId: event.id,
            type: event.event_type,
            verified: true,
            duplicate: true,
        };
    }

    const invoiceId = await handle(db, event);

    return {
        eventId: event.id,
        type: event.event_type,
        invoiceId,
        verified: true,
    };
}

async function handle(db: Db, event: Event): Promise<string | null> {
    // The capture events carry the capture's own id; the attempt is stored
    // under the order id, which only the supplementary data holds.
    const orderId =
        event.resource?.supplementary_data?.related_ids?.order_id ?? null;
    const feeCents = centsOf(
        event.resource?.seller_receivable_breakdown?.paypal_fee?.value,
    );
    // PayPal puts the figure in `amount.value` on a capture and in
    // `amount.total` on the older sale shape — `readSale` reads `.total` for
    // exactly this reason. Reading only one of them turns a real reversal
    // into a zero, which `recordRefund` then refuses.
    const amountCents =
        centsOf(event.resource?.amount?.value) ??
        centsOf(event.resource?.amount?.total);

    switch (event.event_type) {
        case "PAYMENT.CAPTURE.COMPLETED": {
            if (!orderId) {
                // A completed capture we cannot tie to an order is money we
                // cannot book. Silence would be the worst possible answer.
                await notifyUnmatchedPayment({
                    provider: "paypal",
                    providerRef: event.resource?.id ?? "unbekannt",
                    event: event.event_type,
                });

                return null;
            }

            const outcome = await applyPayment(db, {
                ref: orderId,
                gateway: "paypal",
                captureRef: event.resource?.id ?? null,
                amountCents: amountCents ?? undefined,
                feeCents,
                actor: { type: "system", label: "paypal" },
            });

            if (!outcome.known) {
                await notifyUnmatchedPayment({
                    provider: "paypal",
                    providerRef: orderId,
                    event: event.event_type,
                });

                return null;
            }

            await emitInvoicePaid(outcome);

            return outcome.invoiceId;
        }

        case "PAYMENT.CAPTURE.DENIED":
        case "PAYMENT.CAPTURE.DECLINED": {
            if (orderId) {
                await failPayment({
                    provider: "paypal",
                    providerRef: orderId,
                    code: event.event_type,
                });
            }

            return null;
        }

        case "CHECKOUT.ORDER.APPROVED": {
            // Approval is not money — the order still has to be captured, and
            // the customer who closes the tab on PayPal's thank-you page
            // never reaches the page that would do it. So this path captures
            // too; whichever of the two gets there second is told the order
            // was already captured, which is treated as success.
            const id = event.resource?.id;

            if (!id) {
                return null;
            }

            const capture = await captureApprovedOrder(id);

            if (capture.captureStatus !== "COMPLETED") {
                await failPayment({
                    provider: "paypal",
                    providerRef: id,
                    code: capture.captureStatus ?? capture.status,
                });

                return null;
            }

            const outcome = await applyPayment(db, {
                ref: id,
                gateway: "paypal",
                captureRef: capture.captureId,
                amountCents: capture.amountCents ?? undefined,
                feeCents: capture.feeCents,
                actor: { type: "system", label: "paypal" },
            });

            if (!outcome.known) {
                await notifyUnmatchedPayment({
                    provider: "paypal",
                    providerRef: id,
                    event: event.event_type,
                });

                return null;
            }

            await emitInvoicePaid(outcome);

            return outcome.invoiceId;
        }

        /**
         * A collection PayPal made on its own schedule, in the subscriptions
         * recurring mode. The one path where no attempt was recorded first,
         * because nobody here pressed the button.
         */
        case "PAYMENT.SALE.COMPLETED": {
            const sale = readSale(event.resource ?? {});

            if (!sale) {
                return null;
            }

            const mapping = await mapSubscriptionSale(db, sale);

            if (!mapping.matched) {
                await notifyUnmatchedPayment({
                    provider: "paypal",
                    providerRef: sale.billingAgreementId,
                    event: event.event_type,
                });

                return null;
            }

            return mapping.invoiceId;
        }

        // Money going back out; booked as a refund, which puts the invoice
        // back where the money leaves it.
        case "PAYMENT.CAPTURE.REFUNDED":
        case "PAYMENT.CAPTURE.REVERSED": {
            const refundId = event.resource?.id ?? null;
            const captureRef =
                event.resource?.supplementary_data?.related_ids?.order_id ??
                null;

            // The refund resource names the capture it reverses in
            // `links[rel=up]`; the capture id is also the key our charge rows
            // carry, so it is looked up from the refund's own id first.
            const target = await captureOfRefund(db, event, captureRef);

            if (!refundId || !target) {
                await notifyUnmatchedPayment({
                    provider: "paypal",
                    providerRef: refundId ?? "unbekannt",
                    event: event.event_type,
                });

                return null;
            }

            const result = await recordReversal(db, {
                provider: "paypal",
                captureRef: target,
                refundRef: refundId,
                amountCents: amountCents ?? 0,
                event: event.event_type,
            });

            const [row] = await db
                .select({ invoiceId: schema.payment.invoiceId })
                .from(schema.payment)
                .where(eq(schema.payment.captureRef, target));

            /**
             * Refused, not merely already-known. The money has left the
             * PayPal balance and our books still say it is here — and
             * returning quietly here used to mark the event handled, so
             * PayPal never retried and nobody was told. The two silent cases
             * are a missing or unreadable amount and a reversal larger than
             * what is left of the charge; both want a human the same day.
             */
            if (!result.ok) {
                await notifyUnbookedReversal({
                    provider: "paypal",
                    providerRef: refundId,
                    amountCents: amountCents ?? 0,
                    event: event.event_type,
                    reason: result.reason,
                });

                return row?.invoiceId ?? null;
            }

            if (result.changed) {
                await notifyReversal({
                    invoiceId: row?.invoiceId ?? null,
                    amountCents: amountCents ?? 0,
                    event: event.event_type,
                });
            }

            return row?.invoiceId ?? null;
        }

        default:
            return null;
    }
}

/**
 * The capture a refund reverses.
 *
 * PayPal's refund resource does not repeat the capture id in a field; it is
 * in `links`, and the supplementary data carries the order. Rather than parse
 * a link, the charge is found by whichever of the two references we already
 * hold — which also means a refund we cannot tie to a charge of ours is
 * reported rather than guessed at.
 */
async function captureOfRefund(
    db: Db,
    event: Event,
    orderId: string | null,
): Promise<string | null> {
    if (orderId) {
        const [byOrder] = await db
            .select({ captureRef: schema.payment.captureRef })
            .from(schema.payment)
            .where(eq(schema.payment.providerRef, orderId));

        if (byOrder?.captureRef) {
            return byOrder.captureRef;
        }
    }

    const customId = event.resource?.custom_id;

    if (!customId) {
        return null;
    }

    // `custom_id` is our invoice id. It is not trusted to *name* anything —
    // it is only used to find a charge of ours, and the charge's own capture
    // reference is what the refund is then recorded against.
    const [byInvoice] = await db
        .select({ captureRef: schema.payment.captureRef })
        .from(schema.payment)
        .where(eq(schema.payment.invoiceId, customId));

    return byInvoice?.captureRef ?? null;
}
