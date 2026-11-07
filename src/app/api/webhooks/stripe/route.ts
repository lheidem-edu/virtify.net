import { db } from "@/db";
import { gateway } from "@/server/payments/gateways";
import type { WebhookOutcome } from "@/server/payments/gateways/types";
import { revalidateAfterPayment } from "@/server/payments/settle";
import { gatewayConfig } from "@/server/payments/settings";
import { markEventHandled } from "@/server/payments/webhook-log";

/**
 * Stripe's deliveries. The route transports; the gateway decides.
 *
 * It does as little as possible, because Checkout holds the customer's
 * redirect for up to ten seconds waiting for this handler.
 *
 * The signature check inside the gateway **is** this route's authorization:
 * there is no session and no API key here, and an unverified body is hostile
 * input. Nothing in it is ever allowed to name the invoice it settles — see
 * `gateways/stripe-webhook.ts`.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
    const config = await gatewayConfig("stripe");

    if (!config.credentials.secretKey || !config.credentials.webhookSecret) {
        return new Response("payments are not configured", { status: 503 });
    }

    let outcome: WebhookOutcome;

    try {
        outcome = await gateway("stripe").handleWebhook(request);
    } catch (error) {
        // `handled_at` was never set, so Stripe's retry is a real retry.
        console.error("[payments] the stripe webhook failed:", error);

        return new Response("handler failed", { status: 500 });
    }

    if (!outcome.verified) {
        return new Response("invalid signature", { status: 400 });
    }

    if (outcome.duplicate) {
        return new Response("ok", { status: 200 });
    }

    revalidateAfterPayment(outcome.invoiceId ?? null);
    await markEventHandled(db, outcome.eventId);

    return new Response("ok", { status: 200 });
}
