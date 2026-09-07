import "server-only";
import { site } from "@/lib/site";

/**
 * Payments are optional infrastructure: without keys the buttons simply do not
 * appear, and everything else in the application keeps working. That is what
 * makes it safe to ship this before the accounts exist.
 */

export const stripeConfig = {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
} as const;

export const paypalConfig = {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
    /** Never inferred from NODE_ENV — a live key with a sandbox base is silent. */
    base:
        process.env.PAYPAL_ENV === "live"
            ? "https://api-m.paypal.com"
            : "https://api-m.sandbox.paypal.com",
    /**
     * Charging a stored PayPal wallet needs "reference transactions", which
     * PayPal grants per account on request and not by default. Sandbox has it
     * on, live almost certainly does not, so the switch stays off until the
     * approval is in hand — otherwise the customer meets
     * MERCHANT_NOT_ENABLED_FOR_REFERENCE_TRANSACTION at the worst moment.
     */
    vaulting: process.env.PAYPAL_VAULTING_ENABLED === "true",
} as const;

export function stripeEnabled() {
    return Boolean(stripeConfig.secretKey);
}

export function paypalEnabled() {
    return Boolean(paypalConfig.clientId && paypalConfig.clientSecret);
}

/** Where the provider sends the browser back. Localhost in development. */
export function appUrl() {
    return process.env.BETTER_AUTH_URL ?? site.url;
}
