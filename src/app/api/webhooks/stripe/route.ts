import type Stripe from "stripe";
import { stripeConfig, stripeEnabled } from "@/lib/payments/config";
import {
    failPayment,
    firstDelivery,
    forgetDelivery,
    markProcessing,
    markReversed,
    notifyUnmatchedPayment,
    revalidateAfterPayment,
    settlePayment,
} from "@/lib/payments/settle";
import { readFeeCents, stripe } from "@/lib/payments/stripe";

/**
 * Stripe's word on whether money moved. The signature is computed over the
 * exact bytes that arrived, so the body is read as text and never parsed
 * first — `request.json()` here breaks verification with an error that does
 * not say why.
 *
 * Checkout holds the customer's redirect for up to ten seconds waiting for
 * this handler, so it does the least possible: verify, dedupe, settle.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
    if (!stripeEnabled() || !stripeConfig.webhookSecret) {
        return new Response("payments are not configured", { status: 503 });
    }

    const signature = request.headers.get("stripe-signature");
    const body = await request.text();

    let event: Stripe.Event;

    try {
        event = stripe().webhooks.constructEvent(
            body,
            signature ?? "",
            stripeConfig.webhookSecret,
        );
    } catch (error) {
        console.error("[payments] stripe signature rejected:", error);
        return new Response("invalid signature", { status: 400 });
    }

    if (
        !(await firstDelivery({
            id: event.id,
            provider: "stripe",
            type: event.type,
        }))
    ) {
        return new Response("ok", { status: 200 });
    }

    try {
        await handle(event);
    } catch (error) {
        // The dedupe row has to go back, or Stripe's retry would find the
        // event already delivered and answer 200 without doing anything —
        // turning a transient failure into a payment that never settles.
        console.error(`[payments] stripe ${event.type} failed:`, error);
        await forgetDelivery(event.id);
        return new Response("handler failed", { status: 500 });
    }

    return new Response("ok", { status: 200 });
}

async function handle(event: Stripe.Event) {
    switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
            const session = event.data.object;

            // A completed session is not automatically a paid one: methods
            // with delayed notification finish later, through the async event.
            if (session.payment_status === "unpaid") {
                await markProcessing({
                    provider: "stripe",
                    providerRef: session.id,
                });
                return;
            }

            const intentId =
                typeof session.payment_intent === "string"
                    ? session.payment_intent
                    : (session.payment_intent?.id ?? null);

            const outcome = await settlePayment({
                provider: "stripe",
                providerRef: session.id,
                captureRef: intentId,
                feeCents: intentId ? await fee(intentId) : null,
            });

            if (!outcome.known) {
                await notifyUnmatchedPayment({
                    provider: "stripe",
                    providerRef: session.id,
                    event: event.type,
                });
                return;
            }

            revalidateAfterPayment(outcome.invoiceId);
            return;
        }

        case "checkout.session.async_payment_failed":
        case "checkout.session.expired": {
            await failPayment({
                provider: "stripe",
                providerRef: event.data.object.id,
                code: event.type,
            });
            return;
        }

        // The off-session collections have no session; they are keyed on the
        // PaymentIntent, which is what we stored as their reference.
        case "payment_intent.succeeded": {
            const intent = event.data.object;

            const outcome = await settlePayment({
                provider: "stripe",
                providerRef: intent.id,
                captureRef: intent.id,
                feeCents: await fee(intent.id),
            });

            if (!outcome.known) {
                await notifyUnmatchedPayment({
                    provider: "stripe",
                    providerRef: intent.id,
                    event: event.type,
                });
                return;
            }

            revalidateAfterPayment(outcome.invoiceId);
            return;
        }

        case "payment_intent.processing": {
            await markProcessing({
                provider: "stripe",
                providerRef: event.data.object.id,
            });
            return;
        }

        case "payment_intent.payment_failed": {
            const intent = event.data.object;

            await failPayment({
                provider: "stripe",
                providerRef: intent.id,
                code: intent.last_payment_error?.code ?? null,
                message: intent.last_payment_error?.message ?? null,
            });
            return;
        }

        // Money going back out. The invoice is deliberately left alone: what
        // a refund means for it — a correction, a re-issue, nothing — is a
        // decision, and § 8 leaves those to the operator.
        case "charge.refunded":
        case "charge.dispute.created": {
            const charge = event.data.object;
            const intentId =
                typeof charge.payment_intent === "string"
                    ? charge.payment_intent
                    : (charge.payment_intent?.id ?? null);

            await markReversed({
                provider: "stripe",
                captureRef: intentId,
                event: event.type,
            });
            return;
        }

        default:
            return;
    }
}

/**
 * The provider's cut is bookkeeping decoration. It costs another API call, and
 * that call must never be the reason a payment fails to settle.
 */
async function fee(paymentIntentId: string) {
    try {
        return await readFeeCents(paymentIntentId);
    } catch (error) {
        console.error("[payments] reading the stripe fee failed:", error);
        return null;
    }
}
