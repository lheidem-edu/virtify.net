"use server";

import { and, asc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { isOpenInvoice } from "@/db/schema";
import { subtract } from "@/lib/money";
import type { Actor } from "@/server/audit";
import { requirePermission } from "@/server/auth/staff-session";
import { storeFinalizedPdf } from "@/server/billing/invoices/pdf";
import {
    createCreditNote,
    createInvoiceDraft,
    deleteInvoiceDraft,
    finalizeInvoice,
    InvoiceError,
    markDocumentSent,
    unmarkInvoicePaid as unmarkPaid,
    updateInvoiceDraft,
} from "@/server/billing/invoices/service";
import { parseDate, readLineItems } from "@/server/documents/line-items";
import { loadBuyer } from "@/server/documents/repository";
import { sendCreditNoteMail, sendInvoiceMail } from "@/server/documents/send";
import { applyPayment } from "@/server/payments/apply";
import { collectIssuedInvoice } from "@/server/payments/collect";
import { emitInvoicePaid } from "@/server/payments/settle";

/**
 * The admin area's invoice actions. Thin on purpose: every one of them checks
 * the permission, turns a FormData into the service's input and translates
 * the service's error into a sentence. The rules — what may be edited, how a
 * number is assigned, what a correction is — live in
 * `src/server/billing/invoices`, which the API routes call too.
 */

export type InvoiceState = {
    status:
        | "idle"
        | "created"
        | "issued"
        /** Issued and collected from the contract's stored payment method. */
        | "collected"
        | "saved"
        | "cancelled"
        | "sent"
        | "error";
    message?: string;
};

async function actorFor(permission: "billing.write") {
    const session = await requirePermission(permission);

    return {
        type: "staff",
        id: session.user.id,
        label: session.user.email,
    } satisfies Actor;
}

function failure(error: unknown, fallback: string): InvoiceState {
    if (error instanceof InvoiceError) {
        return { status: "error", message: error.message };
    }

    console.error("[admin] invoice action failed:", error);

    return { status: "error", message: fallback };
}

/** Draft input as the two forms post it. */
function readDraft(data: FormData) {
    const read = (name: string) => String(data.get(name) ?? "").trim();
    const customerId = read("customerId");
    const items = readLineItems(data);

    if (!customerId) {
        return { error: "Kein Konto ausgewählt." as const };
    }

    if (!items) {
        return {
            error: "Mindestens eine Position mit gültiger Menge und Preis." as const,
        };
    }

    return {
        input: {
            customerId,
            contractId: read("contractId") || null,
            introText: read("introText") || null,
            note: read("note") || null,
            servicePeriodStart: parseDate(read("servicePeriodStart")),
            servicePeriodEnd: parseDate(read("servicePeriodEnd")),
            items: items.map((item) => ({
                description: item.description,
                detail: item.detail ?? null,
                quantity: item.quantity,
                unitCode: item.unitCode,
                unitPriceCents: item.unitPriceCents,
            })),
        },
    };
}

export async function createInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const draft = readDraft(data);

    if ("error" in draft) {
        return { status: "error", message: draft.error };
    }

    try {
        const row = await createInvoiceDraft(db, draft.input, actor);

        revalidatePath("/admin/invoices");

        return { status: "created", message: row.id };
    } catch (error) {
        return failure(error, "Die Rechnung konnte nicht angelegt werden.");
    }
}

export async function updateInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const invoiceId = String(data.get("invoiceId") ?? "");
    const draft = readDraft(data);

    if ("error" in draft) {
        return { status: "error", message: draft.error };
    }

    try {
        await updateInvoiceDraft(db, invoiceId, draft.input, actor);
    } catch (error) {
        return failure(error, "Die Rechnung konnte nicht gespeichert werden.");
    }

    revalidatePath("/admin/invoices");
    revalidatePath(`/admin/invoices/${invoiceId}`);

    return { status: "saved" };
}

/**
 * Last month's invoice is almost always this month's invoice. Copying one
 * into a fresh draft costs nothing from the RE- series — a draft has no
 * number — and saves retyping the positions of a recurring contract twelve
 * times a year. The service period moves on by a month; everything else is
 * the original's.
 */
export async function duplicateInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const invoiceId = String(data.get("invoiceId") ?? "");

    try {
        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoiceId));

        if (!row) {
            throw new InvoiceError(
                "not-found",
                "Diese Rechnung gibt es nicht.",
            );
        }

        const items = await db
            .select()
            .from(schema.invoiceItem)
            .where(eq(schema.invoiceItem.invoiceId, invoiceId))
            .orderBy(asc(schema.invoiceItem.position));

        if (items.length === 0) {
            throw new InvoiceError(
                "no-items",
                "Diese Rechnung hat keine Positionen.",
            );
        }

        const copy = await createInvoiceDraft(
            db,
            {
                customerId: row.customerId,
                contractId: row.contractId,
                introText: row.introText,
                note: row.note,
                servicePeriodStart: shiftMonth(row.servicePeriodStart),
                servicePeriodEnd: shiftMonth(row.servicePeriodEnd),
                items: items.map((item) => ({
                    description: item.description,
                    detail: item.detail,
                    quantity: item.quantity,
                    unitCode: item.unitCode,
                    unitPriceCents: item.unitPriceCents,
                    servicePeriodStart: shiftMonth(item.servicePeriodStart),
                    servicePeriodEnd: shiftMonth(item.servicePeriodEnd),
                })),
            },
            actor,
        );

        revalidatePath("/admin/invoices");

        return { status: "created", message: copy.id };
    } catch (error) {
        return failure(error, "Die Rechnung konnte nicht dupliziert werden.");
    }
}

/** One calendar month on, clamped like § 188 BGB: 31.01. becomes 28.02. */
function shiftMonth(date: Date | null) {
    if (!date) {
        return null;
    }

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    return new Date(
        Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)),
    );
}

export async function deleteInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const invoiceId = String(data.get("invoiceId") ?? "");

    try {
        await deleteInvoiceDraft(db, invoiceId, actor);
    } catch (error) {
        return failure(error, "Die Rechnung konnte nicht gelöscht werden.");
    }

    revalidatePath("/admin/invoices");

    // The detail page this runs from no longer has a row behind it.
    redirect("/admin/invoices");
}

/**
 * Finalizing is the point of no return: the number required by § 14 Abs. 4
 * Nr. 4 UStG is assigned, the tax strategy in force at this instant is
 * applied and frozen, and the document becomes read-only.
 *
 * The PDF, the mail and the collection all happen afterwards and
 * independently of each other: neither a slow renderer, nor a mail server,
 * nor a declined card may roll back a number that has been handed out.
 */
export async function issueInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const invoiceId = String(data.get("invoiceId") ?? "");

    let collects = false;
    let recipientEmail = "";
    let recipientName = "";

    try {
        const { invoice } = await finalizeInvoice(db, invoiceId, actor);

        const buyer = await loadBuyer(invoice.customerId, db);
        recipientEmail = buyer.email;
        recipientName = buyer.name;

        if (invoice.contractId) {
            const [linked] = await db
                .select({ paymentMethodId: schema.contract.paymentMethodId })
                .from(schema.contract)
                .where(eq(schema.contract.id, invoice.contractId));

            collects = Boolean(linked?.paymentMethodId);
        }
    } catch (error) {
        return failure(error, "Die Rechnung konnte nicht ausgestellt werden.");
    }

    // The PDF is written here rather than inside the transaction: rendering
    // takes a few hundred milliseconds, and holding the number counter's
    // lock for all of them would turn a burst of renewals into a queue.
    await storeFinalizedPdf(db, "invoice", invoiceId);

    let mailed = true;

    try {
        await sendInvoiceMail(invoiceId, recipientEmail, recipientName);
        await markDocumentSent(db, "invoice", invoiceId);
    } catch (error) {
        console.error("[admin] invoice issued but mail failed:", error);
        mailed = false;
    }

    // collectIssuedInvoice already mails the operator about a failure and
    // returns { attempted: false } when nothing is stored for the contract,
    // so this only turns the outcome into a sentence the form can show.
    let collected: boolean | null = null;

    if (collects) {
        try {
            const result = await collectIssuedInvoice(invoiceId);
            // A collection still in flight is neither: the gateway will say
            // by webhook whether it came through, and "failed" here would
            // send the operator after money that is on its way. So is one
            // waiting for the customer's SCA confirmation — they have been
            // mailed a link and the invoice stays open until they use it.
            collected = !result.attempted
                ? null
                : result.status === "succeeded"
                  ? true
                  : result.status === "failed"
                    ? false
                    : null;
        } catch (error) {
            console.error(
                "[admin] invoice issued but collecting failed:",
                error,
            );
            collected = false;
        }
    }

    if (!mailed || collected === false) {
        // Deliberately not revalidated: a refresh re-renders the row this
        // form lives in, unmounts it and takes the message with it. The
        // mutation is committed either way and the sentence below says so;
        // the next navigation picks up the new state.
        return {
            status: "error",
            message: !mailed
                ? collected === false
                    ? "Die Rechnung ist ausgestellt, aber weder der E-Mail-Versand noch der Einzug haben geklappt. Sie liegt im Kundenbereich bereit."
                    : "Die Rechnung ist ausgestellt, aber der E-Mail-Versand hat nicht geklappt. Sie liegt im Kundenbereich bereit."
                : "Die Rechnung ist ausgestellt, der Einzug ist aber fehlgeschlagen. Sie steht im Kundenbereich zur Zahlung bereit.",
        };
    }

    if (collected) {
        return {
            status: "collected",
            message:
                "Die Rechnung ist ausgestellt und der Betrag wurde eingezogen.",
        };
    }

    revalidatePath("/admin/invoices");
    revalidatePath(`/admin/invoices/${invoiceId}`);
    revalidatePath("/client/invoices");

    return { status: "issued" };
}

/**
 * "Bezahlt" without typing an amount: books the whole outstanding balance as
 * a transfer.
 *
 * It goes through `applyPayment` rather than setting the status directly, and
 * that is the point. A status set by hand leaves no transaction behind, so
 * the invoice would read "bezahlt" while the payments list showed nothing and
 * `paid_cents` stayed at zero — and a webhook arriving afterwards would then
 * settle it a second time. One path, or none.
 */
export async function markInvoicePaid(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const invoiceId = String(data.get("invoiceId") ?? "");
    const token = String(data.get("token") ?? "").trim();

    const [invoice] = await db
        .select({
            id: schema.invoice.id,
            customerId: schema.invoice.customerId,
            status: schema.invoice.status,
            grossCents: schema.invoice.grossCents,
            creditedCents: schema.invoice.creditedCents,
            paidCents: schema.invoice.paidCents,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId));

    if (!invoice || !isOpenInvoice(invoice.status)) {
        return {
            status: "error",
            message:
                "Nur offene Rechnungen können als bezahlt verbucht werden.",
        };
    }

    const outstanding = subtract(
        Math.max(subtract(invoice.grossCents ?? 0, invoice.creditedCents), 0),
        invoice.paidCents,
    );

    if (outstanding <= 0) {
        return {
            status: "error",
            message: "Auf diese Rechnung ist nichts mehr offen.",
        };
    }

    const outcome = await applyPayment(db, {
        // The token is minted when the page renders, so a double-clicked
        // button posts the same reference twice and books once.
        ref: `banktransfer:${token || invoiceId}`,
        gateway: "banktransfer",
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        amountCents: outstanding,
        note: "Von Hand als bezahlt verbucht",
        actor,
    });

    if (!outcome.changed) {
        return {
            status: "error",
            message: outcome.known
                ? "Dieser Zahlungseingang ist bereits verbucht."
                : "Die Zahlung konnte nicht vermerkt werden.",
        };
    }

    await emitInvoicePaid(outcome);

    revalidatePath("/admin/invoices");
    revalidatePath(`/admin/invoices/${invoiceId}`);
    revalidatePath("/admin/payments");
    revalidatePath("/client/invoices");

    return { status: "saved" };
}

/**
 * Taking a booking back.
 *
 * Only where nothing actually moved — an invoice somebody marked paid by
 * mistake and that has no settled transaction against it. Where money did
 * arrive, the way back is a refund and, if the document is wrong, a
 * Rechnungskorrektur. Flipping the status would leave the payment rows
 * standing and the books disagreeing with the invoice.
 */
export async function unmarkInvoicePaid(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const invoiceId = String(data.get("invoiceId") ?? "");

    const settled = await db
        .select({ id: schema.payment.id })
        .from(schema.payment)
        .where(
            and(
                eq(schema.payment.invoiceId, invoiceId),
                eq(schema.payment.kind, "charge"),
                inArray(schema.payment.status, ["succeeded", "refunded"]),
            ),
        );

    if (settled.length > 0) {
        return {
            status: "error",
            message:
                "Zu dieser Rechnung ist Geld verbucht. Nimm es über „Erstatten“ zurück, statt den Status zu ändern.",
        };
    }

    try {
        await unmarkPaid(db, invoiceId, actor);
    } catch (error) {
        return failure(
            error,
            "Die Zahlung konnte nicht zurückgenommen werden.",
        );
    }

    revalidatePath("/admin/invoices");
    revalidatePath(`/admin/invoices/${invoiceId}`);
    revalidatePath("/client/invoices");

    return { status: "saved" };
}

/**
 * Cancelling an invoice means issuing a full Rechnungskorrektur against it —
 * AGB § 7 (7): "Eine ausgestellte Rechnung wird nicht verändert. Korrekturen
 * erfolgen durch Stornierung und Neuausstellung."
 */
export async function cancelInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    const actor = await actorFor("billing.write");
    const invoiceId = String(data.get("invoiceId") ?? "");
    const reason = String(data.get("reason") ?? "").trim() || null;

    let creditNoteId = "";
    let recipientEmail = "";
    let recipientName = "";

    try {
        const [row] = await db
            .select({ customerId: schema.invoice.customerId })
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoiceId));

        if (!row) {
            throw new InvoiceError(
                "not-found",
                "Diese Rechnung gibt es nicht.",
            );
        }

        const created = await createCreditNote(
            db,
            { invoiceId, kind: "full", reason },
            actor,
        );

        creditNoteId = created.id;

        const buyer = await loadBuyer(row.customerId, db);
        recipientEmail = buyer.email;
        recipientName = buyer.name;
    } catch (error) {
        return failure(error, "Die Rechnung konnte nicht storniert werden.");
    }

    await storeFinalizedPdf(db, "creditNote", creditNoteId);

    try {
        await sendCreditNoteMail(creditNoteId, recipientEmail, recipientName);
        await markDocumentSent(db, "creditNote", creditNoteId);
    } catch (error) {
        console.error("[admin] correction created but mail failed:", error);

        return {
            status: "error",
            message:
                "Die Rechnungskorrektur ist erstellt, aber der E-Mail-Versand hat nicht geklappt. Sie liegt im Kundenbereich bereit.",
        };
    }

    revalidatePath("/admin/invoices");
    revalidatePath(`/admin/invoices/${invoiceId}`);
    revalidatePath("/client/invoices");

    return { status: "cancelled", message: creditNoteId };
}

/**
 * Sends the document again, for a mail that bounced or never arrived. It
 * reads only: number, recipient and every other frozen field stay as they
 * were, so the customer receives the same document a second time.
 */
export async function resendInvoiceMail(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requirePermission("billing.write");

    const invoiceId = String(data.get("invoiceId") ?? "");

    try {
        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoiceId));

        // A cancelled invoice is annulled: sending it again would put a
        // payable document the customer no longer owes back in their inbox.
        if (
            !row?.number ||
            (!isOpenInvoice(row.status) && row.status !== "paid")
        ) {
            throw new InvoiceError(
                "not-finalized",
                "Nur ausgestellte Rechnungen können erneut versendet werden.",
            );
        }

        const buyer = await loadBuyer(row.customerId, db);

        await sendInvoiceMail(invoiceId, buyer.email, buyer.name);
        await markDocumentSent(db, "invoice", invoiceId);
    } catch (error) {
        return failure(error, "Der erneute Versand hat nicht geklappt.");
    }

    return { status: "sent" };
}

/** Sends a Rechnungskorrektur again. */
export async function resendCreditNoteMail(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requirePermission("billing.write");

    const creditNoteId = String(data.get("creditNoteId") ?? "");

    try {
        const [row] = await db
            .select()
            .from(schema.creditNote)
            .where(eq(schema.creditNote.id, creditNoteId));

        if (!row) {
            throw new InvoiceError(
                "not-found",
                "Diese Rechnungskorrektur gibt es nicht.",
            );
        }

        const buyer = await loadBuyer(row.customerId, db);

        await sendCreditNoteMail(creditNoteId, buyer.email, buyer.name);
        await markDocumentSent(db, "creditNote", creditNoteId);
    } catch (error) {
        return failure(error, "Der erneute Versand hat nicht geklappt.");
    }

    return { status: "sent" };
}
