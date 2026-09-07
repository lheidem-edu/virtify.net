import { captureAndSettle } from "@/lib/payments/collect";
import { paypalConfig, paypalEnabled } from "@/lib/payments/config";
import { verifyWebhook } from "@/lib/payments/paypal";
import {
    failPayment,
    firstDelivery,
    forgetDelivery,
    markReversed,
    notifyUnmatchedPayment,
    revalidateAfterPayment,
    settlePayment,
} from "@/lib/payments/settle";

/**
 * PayPal's word on whether money moved. There is no signing secret: the
 * headers and the untouched body go back to PayPal, which answers whether it
 * sent them. The body therefore has to be the exact string that arrived.
 */
export const runtime = "nodejs";

type Event = {
    id: string;
    event_type: string;
    resource?: {
        id?: string;
        status?: string;
        /** Our own invoice id, put there when the order was created. */
        custom_id?: string;
        supplementary_data?: { related_ids?: { order_id?: string } };
        seller_receivable_breakdown?: { paypal_fee?: { value: string } };
    };
};

export async function POST(request: Request) {
    // Without the webhook id nothing can be verified, so every genuine event
    // would be answered "invalid signature". That is a configuration gap and
    // has to say so, the same way the Stripe route does.
    if (!paypalEnabled() || !paypalConfig.webhookId) {
        return new Response("payments are not configured", { status: 503 });
    }

    const body = await request.text();

    let verified = false;

    try {
        verified = await verifyWebhook({
            headers: request.headers,
            rawBody: body,
        });
    } catch (error) {
        console.error("[payments] paypal verification failed:", error);
        return new Response("verification failed", { status: 500 });
    }

    if (!verified) {
        return new Response("invalid signature", { status: 400 });
    }

    const event = JSON.parse(body) as Event;

    if (
        !(await firstDelivery({
            id: event.id,
            provider: "paypal",
            type: event.event_type,
        }))
    ) {
        return new Response("ok", { status: 200 });
    }

    try {
        await handle(event);
    } catch (error) {
        // Released so PayPal's retry is not deduped into a silent no-op.
        console.error(`[payments] paypal ${event.event_type} failed:`, error);
        await forgetDelivery(event.id);
        return new Response("handler failed", { status: 500 });
    }

    return new Response("ok", { status: 200 });
}

async function handle(event: Event) {
    // The capture events carry the capture's own id; the attempt is stored
    // under the order id, which only the supplementary data holds.
    const orderId =
        event.resource?.supplementary_data?.related_ids?.order_id ?? null;
    const fee = event.resource?.seller_receivable_breakdown?.paypal_fee?.value;

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
                return;
            }

            const outcome = await settlePayment({
                provider: "paypal",
                providerRef: orderId,
                captureRef: event.resource?.id ?? null,
                feeCents: fee ? Math.round(Number(fee) * 100) : null,
            });

            if (!outcome.known) {
                await notifyUnmatchedPayment({
                    provider: "paypal",
                    providerRef: orderId,
                    event: event.event_type,
                });
                return;
            }

            revalidateAfterPayment(outcome.invoiceId);
            return;
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
            return;
        }

        case "CHECKOUT.ORDER.APPROVED": {
            // Approval is not money — the order still has to be captured, and
            // the customer who closes the tab on PayPal's thank-you page never
            // reaches the page that would do it. So this path captures too;
            // whichever of the two gets there second is told the order was
            // already captured, which captureAndSettle treats as success.
            const id = event.resource?.id;

            if (id) {
                await captureAndSettle(id);
            }
            return;
        }

        // Money going back out; the invoice is left as it is, deliberately.
        case "PAYMENT.CAPTURE.REFUNDED":
        case "PAYMENT.CAPTURE.REVERSED": {
            await markReversed({
                provider: "paypal",
                captureRef: event.resource?.id ?? null,
                event: event.event_type,
            });
            return;
        }

        default:
            return;
    }
}
