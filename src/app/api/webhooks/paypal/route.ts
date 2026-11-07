import { db } from "@/db";
import { gateway } from "@/server/payments/gateways";
import type { WebhookOutcome } from "@/server/payments/gateways/types";
import { revalidateAfterPayment } from "@/server/payments/settle";
import { gatewayConfig } from "@/server/payments/settings";
import { markEventHandled } from "@/server/payments/webhook-log";

/**
 * PayPal's deliveries.
 *
 * PayPal has no signing secret: the headers and the untouched body go back to
 * PayPal, which answers whether it sent them. That round trip is the
 * authorization, and it happens inside the gateway — see
 * `gateways/paypal-webhook.ts`. Without a configured webhook id nothing can
 * be verified, so every genuine event would be answered "invalid signature";
 * that is a configuration gap and says so, as the Stripe route does.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
    const config = await gatewayConfig("paypal");

    if (!config.credentials.clientId || !config.credentials.webhookId) {
        return new Response("payments are not configured", { status: 503 });
    }

    let outcome: WebhookOutcome;

    try {
        outcome = await gateway("paypal").handleWebhook(request);
    } catch (error) {
        console.error("[payments] the paypal webhook failed:", error);

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
