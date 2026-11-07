import "server-only";
import { giroCodeSvg } from "@/lib/giro-code";
import { loadSettings } from "@/server/settings";
import { gatewayConfig } from "@/server/payments/settings";
import {
    type CheckoutHandoff,
    type ChargeOutcome,
    type GatewayCapabilities,
    type PayableInvoice,
    type PaymentGateway,
    unsupported,
    type WebhookOutcome,
} from "./types";

/**
 * Überweisung — a gateway with no API behind it at all.
 *
 * It is here, implementing the same interface as Stripe and PayPal, for one
 * reason: a bank transfer settles an invoice, and an invoice must have
 * exactly one way of being settled. The alternative is a `markInvoicePaid`
 * that bypasses `applyPayment` — and then a transfer and a card payment for
 * the same invoice are two mechanisms that do not know about each other,
 * which is how an invoice gets paid twice.
 *
 * `createCheckout` therefore returns instructions rather than a URL. There is
 * nowhere to send anybody: the customer pays from their own bank, and
 * somebody books it when it arrives. The GiroCode makes that a scan rather
 * than a transcription, which is also the part that stops the Verwendungszweck
 * being typed wrong — and the Verwendungszweck is what reconciles the payment.
 */

const capabilities: GatewayCapabilities = {
    hostedCheckout: false,
    storedMethods: false,
    offSession: false,
    // No API to ask. A transfer goes back by transfer, and the row is written
    // so the books agree with the account.
    refunds: false,
    webhooks: false,
    manual: true,
};

export const bankTransferGateway: PaymentGateway = {
    id: "banktransfer",
    label: "Überweisung",
    capabilities,

    async isEnabled() {
        return (await gatewayConfig("banktransfer")).enabled;
    },

    async createCheckout(invoice: PayableInvoice): Promise<CheckoutHandoff> {
        const settings = await loadSettings();

        const remittance = `Rechnung ${invoice.number}`;

        return {
            kind: "instructions",
            // The reference is the invoice's own number: that is what the
            // customer will put in the Verwendungszweck and what the operator
            // will match the bank statement against.
            ref: `banktransfer:${invoice.id}`,
            instructions: {
                holder: settings.operator.name,
                iban: settings.bank.iban,
                bic: settings.bank.bic,
                bankName: settings.bank.name,
                amountCents: invoice.amountCents,
                currency: invoice.currency,
                remittance,
                giroCodeSvg: renderGiroCode({
                    name: settings.operator.name,
                    iban: settings.bank.iban,
                    bic: settings.bank.bic,
                    amountCents: invoice.amountCents,
                    remittance,
                }),
            },
        };
    },

    async savePaymentMethod() {
        return unsupported("banktransfer", "Zahlungsmittel speichern");
    },

    async chargeSaved(): Promise<ChargeOutcome> {
        return {
            status: "failed",
            ref: null,
            code: "manual",
            message: "Eine Überweisung lässt sich nicht einziehen.",
        };
    },

    async refund() {
        return unsupported("banktransfer", "automatisch erstatten");
    },

    async handleWebhook(): Promise<WebhookOutcome> {
        return unsupported("banktransfer", "Ereignisse melden");
    },
};

/**
 * A GiroCode is decoration on a page that works without it, so a payload the
 * EPC specification refuses — an IBAN that is not one, a name too long to
 * fit, an amount past the ceiling — hides the code instead of taking the page
 * down with it.
 */
function renderGiroCode(input: {
    name: string;
    iban: string;
    bic: string;
    amountCents: number;
    remittance: string;
}): string | null {
    try {
        return giroCodeSvg({
            name: input.name,
            iban: input.iban,
            bic: input.bic,
            amountCents: input.amountCents,
            remittance: input.remittance,
        });
    } catch (error) {
        console.error("[payments] the GiroCode could not be built:", error);

        return null;
    }
}
