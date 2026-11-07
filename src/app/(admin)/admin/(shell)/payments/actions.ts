"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { parseAmount, subtract } from "@/lib/money";
import { createId } from "@/lib/ulid";
import type { Actor } from "@/server/audit";
import { requirePermission } from "@/server/auth/staff-session";
import { storeFinalizedPdf } from "@/server/billing/invoices/pdf";
import { createCreditNote } from "@/server/billing/invoices/service";
import { adjustCredit, applyPayment } from "@/server/payments/apply";
import { isGatewayId } from "@/server/payments/gateways";
import { refundPayment } from "@/server/payments/refunds";
import { emitInvoicePaid } from "@/server/payments/settle";

export type PaymentState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

async function actorFor(permission: "payments.write" | "billing.write") {
    const session = await requirePermission(permission);

    return {
        type: "staff",
        id: session.user.id,
        label: session.user.email,
    } satisfies Actor;
}

/**
 * Books money that arrived outside a gateway — a transfer on the bank
 * statement, cash, a cheque.
 *
 * It goes through `applyPayment` like everything else. That is the whole
 * point of `banktransfer` being a gateway: a transfer and a card payment for
 * the same invoice must not be two mechanisms that settle it independently.
 *
 * The form carries an idempotency token minted when it was rendered, and that
 * token is the payment's `provider_ref`, which is unique. A double-clicked
 * button, or a reload that re-posts, therefore books once.
 */
export async function bookManualPayment(
    _previous: PaymentState,
    data: FormData,
): Promise<PaymentState> {
    const actor = await actorFor("payments.write");

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const invoiceId = read("invoiceId");
    const gatewayId = read("gateway") || "banktransfer";
    const token = read("token");
    const reference = read("reference");
    const note = read("note");

    if (!isGatewayId(gatewayId)) {
        return { status: "error", message: "Unbekannte Zahlungsart." };
    }

    if (!token) {
        return {
            status: "error",
            message: "Das Formular ist unvollständig. Bitte neu laden.",
        };
    }

    const amountCents = parseAmount(read("amount"));

    if (amountCents === null || amountCents <= 0) {
        return { status: "error", message: "Kein gültiger Betrag." };
    }

    const [invoice] = await db
        .select({
            id: schema.invoice.id,
            customerId: schema.invoice.customerId,
            status: schema.invoice.status,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId));

    if (!invoice || invoice.status === "draft") {
        return {
            status: "error",
            message: "Zu dieser Rechnung lässt sich nichts verbuchen.",
        };
    }

    const bookedAt = read("bookedAt");
    const at = bookedAt ? new Date(`${bookedAt}T12:00:00Z`) : new Date();

    const outcome = await applyPayment(db, {
        // The token is what makes a double submit harmless; the operator's
        // own reference is kept beside it, where a second transfer carrying
        // the same text cannot block the booking.
        ref: `${gatewayId}:${token}`,
        gateway: gatewayId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        amountCents,
        captureRef: null,
        note: [reference, note].filter(Boolean).join(" · ") || null,
        at: Number.isNaN(at.getTime()) ? new Date() : at,
        actor,
    });

    if (!outcome.changed) {
        return {
            status: "error",
            message: outcome.known
                ? "Dieser Zahlungseingang ist bereits verbucht."
                : "Der Zahlungseingang konnte nicht verbucht werden.",
        };
    }

    await emitInvoicePaid(outcome, at);

    revalidatePath("/admin/payments");
    revalidatePath("/admin/invoices");
    revalidatePath(`/admin/invoices/${invoiceId}`);
    revalidatePath("/client/invoices");

    return {
        status: "saved",
        message:
            outcome.creditedToBalanceCents > 0
                ? "Verbucht. Der überzahlte Teil steht dem Kunden als Guthaben zur Verfügung."
                : "Verbucht.",
    };
}

/**
 * Sends money back.
 *
 * A refund is two things, and they are done in this order on purpose:
 *
 *  1. The **Rechnungskorrektur**, which is the document. A finalized invoice
 *     is never edited (rule 3, AGB § 7 (7)), so what the books record is a
 *     credit note on its own gapless number range.
 *  2. The **refund transaction**, which is the money.
 *
 * A correction without a refund is an operator who still owes the customer
 * money, and that is visible on the invoice. A refund without a correction is
 * a document that no longer matches the books, and that is not. So if the
 * money fails to go back, the correction stands and the refund can be
 * retried; the reverse would be unrecoverable.
 *
 * The credit note is optional only where one already exists — a chargeback
 * the operator has already corrected for.
 */
export async function refundTransaction(
    _previous: PaymentState,
    data: FormData,
): Promise<PaymentState> {
    // Issuing a Rechnungskorrektur is a billing decision, so the heavier of
    // the two permissions is the one that is asked for.
    const actor = await actorFor("billing.write");

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const paymentId = read("paymentId");
    const reason = read("reason") || "Erstattung";
    const withCreditNote = read("creditNote") !== "off";

    const amountCents = parseAmount(read("amount"));

    if (amountCents === null || amountCents <= 0) {
        return { status: "error", message: "Kein gültiger Betrag." };
    }

    const [payment] = await db
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.id, paymentId));

    if (payment?.kind !== "charge") {
        return {
            status: "error",
            message: "Diese Zahlung kann nicht erstattet werden.",
        };
    }

    if (amountCents > subtract(payment.amountCents, payment.refundedCents)) {
        return {
            status: "error",
            message:
                "Es kann höchstens der noch nicht erstattete Betrag zurückgezahlt werden.",
        };
    }

    let creditNoteId: string | null = null;

    /**
     * A Rechnungskorrektur credits *positions*, not an amount — EN 16931 and
     * § 14 Abs. 4 want a document that says what was taken back, not a lump
     * sum. So one is issued here only when the refund takes back everything
     * the invoice still stands for; a smaller refund is corrected from the
     * invoice page, where the operator picks the lines they mean.
     */
    const [invoiceOfPayment] = payment.invoiceId
        ? await db
              .select({
                  grossCents: schema.invoice.grossCents,
                  creditedCents: schema.invoice.creditedCents,
              })
              .from(schema.invoice)
              .where(eq(schema.invoice.id, payment.invoiceId))
        : [];

    const stillStandsFor = Math.max(
        subtract(
            invoiceOfPayment?.grossCents ?? 0,
            invoiceOfPayment?.creditedCents ?? 0,
        ),
        0,
    );

    const fullyReversed =
        payment.invoiceId !== null && amountCents === stillStandsFor;

    if (withCreditNote && payment.invoiceId && !fullyReversed) {
        return {
            status: "error",
            message:
                "Eine Rechnungskorrektur nimmt Positionen zurück, keinen Teilbetrag. Erstelle sie auf der Rechnung und erstatte dann ohne Korrektur.",
        };
    }

    if (withCreditNote && payment.invoiceId) {
        try {
            const created = await createCreditNote(
                db,
                {
                    invoiceId: payment.invoiceId,
                    kind: "full",
                    reason,
                },
                actor,
            );

            creditNoteId = created.id;
        } catch (error) {
            console.error("[admin] the correction could not be issued:", error);

            return {
                status: "error",
                message:
                    "Die Rechnungskorrektur konnte nicht erstellt werden; es wurde kein Geld zurückgezahlt.",
            };
        }

        // Outside the transaction: neither a slow renderer nor a full disk
        // may roll back a number that has already been handed out.
        await storeFinalizedPdf(db, "creditNote", creditNoteId);
    }

    const refunded = await refundPayment(db, {
        paymentId,
        amountCents,
        reason,
        actor,
    });

    revalidatePath("/admin/payments");
    revalidatePath("/admin/invoices");
    revalidatePath("/admin/credit-notes");

    if (payment.invoiceId) {
        revalidatePath(`/admin/invoices/${payment.invoiceId}`);
    }

    if (!refunded.ok) {
        return {
            status: "error",
            message: creditNoteId
                ? `Die Rechnungskorrektur ist erstellt, die Rückzahlung aber nicht: ${refunded.reason}`
                : refunded.reason,
        };
    }

    return {
        status: "saved",
        message: creditNoteId
            ? "Erstattet, mit Rechnungskorrektur."
            : "Erstattet.",
    };
}

/** Books credit by hand — goodwill, or a balance paid back out. */
export async function adjustCustomerCredit(
    _previous: PaymentState,
    data: FormData,
): Promise<PaymentState> {
    const actor = await actorFor("payments.write");

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const customerId = read("customerId");
    const reason = read("reason");
    const direction = read("direction") === "debit" ? -1 : 1;

    const magnitude = parseAmount(read("amount"));

    if (magnitude === null || magnitude <= 0) {
        return { status: "error", message: "Kein gültiger Betrag." };
    }

    if (!reason) {
        return { status: "error", message: "Bitte gib einen Grund an." };
    }

    const result = await adjustCredit(db, {
        customerId,
        amountCents: magnitude * direction,
        reason,
        actor,
    });

    if (!result.ok) {
        return {
            status: "error",
            message: "Das Guthaben des Kontos reicht dafür nicht aus.",
        };
    }

    revalidatePath("/admin/payments");
    revalidatePath(`/admin/customers/${customerId}`);
    revalidatePath("/client/credit");

    return { status: "saved", message: "Gebucht." };
}

/** A fresh idempotency token for a hand-booking form. */
export async function manualPaymentToken(): Promise<string> {
    return createId("payment");
}
