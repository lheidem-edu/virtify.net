"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth-session";
import { loadInvoice } from "@/lib/documents/repository";
import { paypalEnabled, stripeEnabled } from "@/lib/payments/config";
import { createInvoiceOrder } from "@/lib/payments/paypal";
import { nextAttempt, recordAttempt } from "@/lib/payments/settle";
import { createInvoiceCheckout } from "@/lib/payments/stripe";

export type PayState = { status: "idle" | "error"; message?: string };

/**
 * Hands one invoice to the provider's hosted page. The attempt is written
 * before the redirect on purpose: a checkout session or order nobody recorded
 * is money arriving at the webhook with nothing to match it against.
 */
export async function startInvoicePayment(
    _previous: PayState,
    data: FormData,
): Promise<PayState> {
    const session = await requireSession();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const invoiceId = read("invoiceId");
    const provider = read("provider");

    if (provider !== "stripe" && provider !== "paypal") {
        return { status: "error", message: "Unbekannte Zahlungsart." };
    }

    if (provider === "stripe" ? !stripeEnabled() : !paypalEnabled()) {
        return {
            status: "error",
            message: "Diese Zahlungsart steht gerade nicht zur Verfügung.",
        };
    }

    // The loader constrains the query to this account, so a foreign invoice
    // comes back as null rather than as a refusal that confirms it exists.
    const loaded = await loadInvoice(invoiceId, session.user.id, false);

    if (!loaded) {
        return { status: "error", message: "Diese Rechnung gibt es nicht." };
    }

    const { invoice, buyer, totals } = loaded;

    // Drafts, Stornos and already settled invoices are never payable — the
    // same rule the list uses to decide whether to offer the button at all.
    if (
        invoice.status !== "issued" ||
        invoice.cancelsInvoiceId ||
        invoice.paidAt
    ) {
        return {
            status: "error",
            message: "Diese Rechnung kann nicht bezahlt werden.",
        };
    }

    if (totals.grossCents <= 0) {
        return {
            status: "error",
            message: "Diese Rechnung weist keinen zu zahlenden Betrag aus.",
        };
    }

    let url: string;

    try {
        const attempt = await nextAttempt(invoice.id);

        const checkout =
            provider === "stripe"
                ? await createInvoiceCheckout({
                      invoiceId: invoice.id,
                      invoiceNumber: invoice.number ?? invoice.id,
                      amountCents: totals.grossCents,
                      customerEmail: buyer.email,
                      stripeCustomerId: buyer.stripeCustomerId ?? undefined,
                      attempt,
                  })
                : await createInvoiceOrder({
                      invoiceId: invoice.id,
                      invoiceNumber: invoice.number ?? invoice.id,
                      amountCents: totals.grossCents,
                      attempt,
                  });

        await recordAttempt({
            invoiceId: invoice.id,
            userId: session.user.id,
            provider,
            providerRef: checkout.id,
            amountCents: totals.grossCents,
        });

        url = checkout.url;
    } catch (error) {
        console.error("[payment] starting invoice payment failed:", error);

        return {
            status: "error",
            message:
                "Die Zahlung konnte nicht gestartet werden. Bitte versuche es erneut.",
        };
    }

    // redirect() works by throwing, so it must sit outside the try above.
    redirect(url);
}
