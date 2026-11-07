"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { getCurrentCustomer } from "@/server/customers/current";
import { payFromCredit } from "@/server/payments/apply";
import { startPayment } from "@/server/payments/collect";
import { isGatewayId } from "@/server/payments/gateways";
import { emitInvoicePaid } from "@/server/payments/settle";

export type PayState = { status: "idle" | "error"; message?: string };

/**
 * Hands one invoice to a gateway.
 *
 * Everything that matters happens in `startPayment`: the invoice is loaded
 * through the customer-scoped loader, so a foreign one is simply not there;
 * what is still owed is read from the document rather than recomputed; the
 * attempt is written down before the customer is sent anywhere; and any
 * checkout this invoice has left open is closed first, so an old tab cannot
 * become a second way to pay the same invoice.
 */
export async function startInvoicePayment(
    _previous: PayState,
    data: FormData,
): Promise<PayState> {
    const { customer } = await getCurrentCustomer();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const invoiceId = read("invoiceId");
    const provider = read("provider");

    if (!isGatewayId(provider)) {
        return { status: "error", message: "Unbekannte Zahlungsart." };
    }

    const started = await startPayment({
        invoiceId,
        customerId: customer.id,
        gatewayId: provider,
    });

    if (!started.ok) {
        return { status: "error", message: started.reason };
    }

    if (started.handoff.kind === "instructions") {
        // There is nowhere to send anybody: the details are on the invoice
        // page, which is where this form lives.
        return { status: "idle" };
    }

    // redirect() works by throwing, so it must sit outside anything that
    // would catch it.
    redirect(started.handoff.url);
}

/**
 * Pays an open invoice from the balance.
 *
 * It is a payment like any other — same table, same settlement, same audit —
 * so an invoice paid half from a card and half from the balance still adds up
 * in one place. The balance is read under a lock on the account, so two tabs
 * cannot spend the same euro twice.
 */
export async function payInvoiceFromCredit(
    _previous: PayState,
    data: FormData,
): Promise<PayState> {
    const { customer } = await getCurrentCustomer();

    const invoiceId = String(data.get("invoiceId") ?? "").trim();
    const amountCents = Number(data.get("amountCents") ?? 0);

    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        return { status: "error", message: "Kein gültiger Betrag." };
    }

    const outcome = await payFromCredit(db, {
        invoiceId,
        customerId: customer.id,
        amountCents,
        actor: { type: "customer", id: customer.id },
    });

    if (!outcome.changed) {
        return {
            status: "error",
            message:
                outcome.reason ??
                "Diese Rechnung kann nicht aus dem Guthaben bezahlt werden.",
        };
    }

    await emitInvoicePaid(outcome);

    revalidatePath("/client/invoices");
    revalidatePath(`/client/invoices/${invoiceId}`);
    revalidatePath("/client/credit");

    return { status: "idle" };
}
