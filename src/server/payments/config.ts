import "server-only";
import { env } from "@/lib/env";
import { site } from "@/lib/site";

/**
 * Payments are optional infrastructure: without keys the buttons simply do not
 * appear, and everything else in the application keeps working. That is what
 * makes it safe to ship this before the accounts exist.
 *
 * These are functions, not constants, because `env` validates the whole
 * environment on first read. A constant would do that while the module is
 * being imported, which is also what `next build` does to trace routes — and
 * a container image is built without any secrets.
 */

export function stripeConfig() {
    return {
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    } as const;
}

export function paypalConfig() {
    return {
        clientId: env.PAYPAL_CLIENT_ID,
        clientSecret: env.PAYPAL_CLIENT_SECRET,
        webhookId: env.PAYPAL_WEBHOOK_ID,
        /** Never inferred from NODE_ENV — a live key with a sandbox base is silent. */
        base:
            env.PAYPAL_ENV === "live"
                ? "https://api-m.paypal.com"
                : "https://api-m.sandbox.paypal.com",
        /**
         * Charging a stored PayPal wallet needs "reference transactions",
         * which PayPal grants per account on request and not by default.
         * Sandbox has it on, live almost certainly does not, so the switch
         * stays off until the approval is in hand — otherwise the customer
         * meets MERCHANT_NOT_ENABLED_FOR_REFERENCE_TRANSACTION at the worst
         * possible moment.
         */
        vaulting: env.PAYPAL_VAULTING_ENABLED,
    } as const;
}

export function stripeEnabled() {
    return Boolean(stripeConfig().secretKey);
}

export function paypalEnabled() {
    const { clientId, clientSecret } = paypalConfig();

    return Boolean(clientId && clientSecret);
}

/** Where the provider sends the browser back. Localhost in development. */
export function appUrl() {
    return env.BETTER_AUTH_URL || site.url;
}
