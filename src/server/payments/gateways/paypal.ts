import "server-only";
import { db } from "@/db";
import { gatewayConfig } from "@/server/payments/settings";
import {
    captureOrder,
    chargeVaultToken,
    createInvoiceOrder,
    createVaultSetupToken,
    paypalIssue,
    readOrder,
    refundCapture,
} from "./paypal-api";
import {
    type ChargeOutcome,
    type CheckoutHandoff,
    type CheckoutOptions,
    type GatewayCapabilities,
    type GatewayCustomer,
    GatewayError,
    type PayableInvoice,
    type PaymentGateway,
    type RefundableTransaction,
    type RefundOutcome,
    type SetupHandoff,
    type StoredMethod,
    type WebhookOutcome,
} from "./types";

const capabilities: GatewayCapabilities = {
    hostedCheckout: true,
    storedMethods: true,
    offSession: true,
    refunds: true,
    webhooks: true,
    manual: false,
};

/**
 * PayPal, behind the one interface.
 *
 * `chargeSaved` is the half that depends on the account: charging a stored
 * wallet needs "reference transactions", which PayPal grants per account on
 * request and not by default. Without that approval every charge fails with
 * MERCHANT_NOT_ENABLED_FOR_REFERENCE_TRANSACTION at the worst possible
 * moment, so the mode is a setting and the default is the one that works for
 * everybody — PayPal's own Subscriptions API, in
 * `./paypal-subscriptions.ts`.
 */
export const paypalGateway: PaymentGateway = {
    id: "paypal",
    label: "PayPal",
    capabilities,

    async isEnabled() {
        return (await gatewayConfig("paypal")).enabled;
    },

    async createCheckout(
        invoice: PayableInvoice,
        options: CheckoutOptions,
    ): Promise<CheckoutHandoff> {
        const order = await createInvoiceOrder({
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            descriptor: invoice.descriptor,
            amountCents: invoice.amountCents,
            currency: invoice.currency,
            attempt: options.attempt,
            returnPath: options.returnPath,
            cancelPath: options.cancelPath,
        });

        return { kind: "redirect", ref: order.id, url: order.url };
    },

    async savePaymentMethod(customer: GatewayCustomer): Promise<SetupHandoff> {
        const config = await gatewayConfig("paypal");

        if (config.paypalRecurringMode !== "vault") {
            throw new GatewayError(
                "paypal",
                "Für dieses Konto ist das Speichern einer PayPal-Zahlungsquelle nicht freigeschaltet.",
                "vaulting_disabled",
            );
        }

        const setup = await createVaultSetupToken({
            customerId: customer.id,
        });

        return { ref: setup.id, url: setup.url };
    },

    async chargeSaved(
        method: StoredMethod,
        invoice: PayableInvoice,
    ): Promise<ChargeOutcome> {
        const config = await gatewayConfig("paypal");

        if (config.paypalRecurringMode !== "vault") {
            return {
                status: "failed",
                ref: null,
                code: "vaulting_disabled",
                message:
                    "Wiederkehrende PayPal-Zahlungen laufen für dieses Konto über die Subscriptions-API.",
            };
        }

        try {
            const capture = await chargeVaultToken({
                invoiceId: invoice.id,
                invoiceNumber: invoice.number,
                amountCents: invoice.amountCents,
                currency: invoice.currency,
                token: method.token,
            });

            if (capture.captureStatus === "COMPLETED") {
                return {
                    status: "succeeded",
                    ref: capture.orderId,
                    captureRef: capture.captureId,
                    // PayPal's own figure, parsed as a decimal string and
                    // never through a float.
                    amountCents: capture.amountCents ?? invoice.amountCents,
                    feeCents: capture.feeCents,
                };
            }

            // PENDING is not a refusal — PayPal is still working on it and
            // will say so by webhook. Reporting it as failed would tell the
            // operator the money did not come, while PayPal quietly settles.
            if (capture.captureStatus === "PENDING") {
                return {
                    status: "processing",
                    ref: capture.orderId,
                    captureRef: capture.captureId,
                };
            }

            return {
                status: "failed",
                ref: capture.orderId,
                code: capture.captureStatus ?? capture.status,
                message: null,
            };
        } catch (error) {
            return {
                status: "failed",
                ref: null,
                code: paypalIssue(error),
                message: error instanceof Error ? error.message : "unbekannt",
            };
        }
    },

    async refund(
        transaction: RefundableTransaction,
        amountCents: number,
    ): Promise<RefundOutcome> {
        if (!transaction.captureRef) {
            throw new GatewayError(
                "paypal",
                "Zu dieser Zahlung ist keine PayPal-Referenz gespeichert.",
            );
        }

        const refund = await refundCapture({
            captureId: transaction.captureRef,
            amountCents,
            currency: "EUR",
            attempt: transaction.attempt,
        });

        return {
            ref: refund.id,
            amountCents: refund.amountCents,
            status: refund.status === "COMPLETED" ? "succeeded" : "pending",
        };
    },

    async handleWebhook(request: Request): Promise<WebhookOutcome> {
        const { handlePayPalWebhook } = await import("./paypal-webhook");

        return handlePayPalWebhook(db, request);
    },
};

/**
 * Captures an approved PayPal order and hands back what happened.
 *
 * Both the customer's return and the webhook end up here, possibly at the
 * same moment — PayPal answers the loser ORDER_ALREADY_CAPTURED, which is a
 * success, not a fault, and the order is read back instead.
 */
export async function captureApprovedOrder(orderId: string) {
    try {
        return await captureOrder(orderId);
    } catch (error) {
        if (paypalIssue(error) !== "ORDER_ALREADY_CAPTURED") {
            throw error;
        }

        return readOrder(orderId);
    }
}
