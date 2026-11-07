"use server";

import { redirect } from "next/navigation";
import { parseAmount } from "@/lib/money";
import { createId } from "@/lib/ulid";
import { getCurrentCustomer } from "@/server/customers/current";
import { gateway, isGatewayId } from "@/server/payments/gateways";
import { recordAttempt } from "@/server/payments/settle";

export type TopUpState = { status: "idle" | "error"; message?: string };

/** The smallest and largest top-up we will start. */
const MINIMUM_CENTS = 500;
const MAXIMUM_CENTS = 100_000;

/**
 * Buys credit.
 *
 * A top-up is the one payment with no document behind it: nothing has been
 * supplied, so there is nothing to invoice — the money becomes a balance,
 * and the invoice that balance later pays is the document. `payment.purpose`
 * is what says so, and the one reason `payment.invoice_id` is nullable.
 *
 * It reuses the ordinary hosted checkout, so the amount still goes to the
 * gateway as whole minor units and comes back through `applyPayment` like
 * everything else.
 */
export async function startCreditTopUp(
    _previous: TopUpState,
    data: FormData,
): Promise<TopUpState> {
    const { customer, contact } = await getCurrentCustomer();

    const read = (name: string) => String(data.get(name) ?? "").trim();
    const provider = read("provider");

    if (!isGatewayId(provider)) {
        return { status: "error", message: "Unbekannte Zahlungsart." };
    }

    const target = gateway(provider);

    if (!(await target.isEnabled()) || !target.capabilities.hostedCheckout) {
        return {
            status: "error",
            message: "Diese Zahlungsart steht gerade nicht zur Verfügung.",
        };
    }

    const amountCents = parseAmount(read("amount"));

    if (
        amountCents === null ||
        amountCents < MINIMUM_CENTS ||
        amountCents > MAXIMUM_CENTS
    ) {
        return {
            status: "error",
            message: `Bitte wähle einen Betrag zwischen ${MINIMUM_CENTS / 100} € und ${MAXIMUM_CENTS / 100} €.`,
        };
    }

    let url: string;

    try {
        /**
         * A top-up has no invoice, so the gateway is handed a stand-in.
         * Nothing downstream reads it as a document: `purpose: "topup"` on
         * the attempt is what decides where the money lands.
         *
         * The "number" has to be **unique per attempt**, because PayPal uses
         * it as the `invoice_id`, which is unique across the whole merchant
         * account — one constant per customer meant the second top-up that
         * customer ever tried was refused with DUPLICATE_INVOICE_ID, and
         * every one after it. The `descriptor` is what the customer actually
         * reads on the provider's page, so the reference stays out of sight.
         */
        const reference = createId("payment");

        const handoff = await target.createCheckout(
            {
                id: `topup:${customer.id}`,
                number: `Guthaben ${customer.customerNumber ?? customer.id} ${reference}`,
                descriptor: "Guthaben-Aufladung",
                amountCents,
                currency: "EUR",
                customerId: customer.id,
                customerEmail: contact.email,
                customerName: customer.company || customer.name,
                stripeCustomerId: customer.stripeCustomerId,
            },
            {
                attempt: Date.now(),
                returnPath: "/client/credit",
                cancelPath: "/client/credit",
            },
        );

        if (handoff.kind !== "redirect") {
            return {
                status: "error",
                message: "Diese Zahlungsart eignet sich nicht zum Aufladen.",
            };
        }

        await recordAttempt({
            invoiceId: null,
            customerId: customer.id,
            provider,
            providerRef: handoff.ref,
            amountCents,
            purpose: "topup",
            note: "Guthabenaufladung",
        });

        url = handoff.url;
    } catch (error) {
        console.error("[payments] starting the top-up failed:", error);

        return {
            status: "error",
            message:
                "Das Aufladen konnte nicht gestartet werden. Bitte versuche es erneut.",
        };
    }

    // redirect() works by throwing, so it must sit outside the try above.
    redirect(url);
}
