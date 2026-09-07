"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import { parseDate, readLineItems } from "@/lib/documents/line-items";
import { nextNumber } from "@/lib/documents/numbering";
import { formatRecipient } from "@/lib/documents/repository";
import { sendInvoiceMail } from "@/lib/documents/send";
import { policy } from "@/lib/site";

export type InvoiceState = {
    status:
        | "idle"
        | "created"
        | "issued"
        | "saved"
        | "cancelled"
        | "sent"
        | "error";
    message?: string;
};

/**
 * A contract may only be billed to the account it belongs to. The picker lists
 * every contract, so without this an invoice could carry another customer's
 * contract into its PDF and onto that contract's detail page.
 */
async function assertContractBelongsTo(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    contractId: string | null,
    userId: string,
) {
    if (!contractId) {
        return;
    }

    const [contract] = await tx
        .select({ userId: schema.contract.userId })
        .from(schema.contract)
        .where(eq(schema.contract.id, contractId));

    if (contract?.userId !== userId) {
        throw new Error("contract-mismatch");
    }
}

export async function createInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const userId = read("userId");
    const items = readLineItems(data);

    if (!userId) {
        return { status: "error", message: "Kein Konto ausgewählt." };
    }

    if (!items) {
        return {
            status: "error",
            message: "Mindestens eine Position mit gültiger Menge und Preis.",
        };
    }

    const id = createId("invoice");

    try {
        await db.transaction(async (tx) => {
            const contractId = read("contractId") || null;
            await assertContractBelongsTo(tx, contractId, userId);

            await tx.insert(schema.invoice).values({
                id,
                userId,
                contractId,
                status: "draft",
                introText: read("introText") || null,
                note: read("note") || null,
                servicePeriodStart: parseDate(read("servicePeriodStart")),
                servicePeriodEnd: parseDate(read("servicePeriodEnd")),
            });

            await tx.insert(schema.invoiceItem).values(
                items.map((item, index) => ({
                    id: createId("invoiceitem"),
                    invoiceId: id,
                    position: index + 1,
                    description: item.description,
                    detail: item.detail ?? null,
                    quantity: item.quantity,
                    unitCode: item.unitCode,
                    unitPriceCents: item.unitPriceCents,
                })),
            );
        });
    } catch (error) {
        console.error("[admin] creating invoice failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "contract-mismatch"
                    ? "Der Vertrag gehört zu einem anderen Konto."
                    : "Die Rechnung konnte nicht angelegt werden.",
        };
    }

    revalidatePath("/account/admin/invoices");

    return { status: "created", message: id };
}

/**
 * The only mutable state an invoice ever has. Once a number is assigned the
 * document is frozen (§ 14 UStG numbering, AGB § 7 (7)) and PDF and XML
 * re-render from these rows, so an edit that reached past "draft" would
 * silently rewrite a document the customer already holds.
 *
 * Positions are deleted and reinserted rather than diffed: the loaders order
 * by `position`, and a full rewrite is what keeps that sequence dense.
 */
export async function updateInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const invoiceId = String(data.get("invoiceId") ?? "");
    const userId = read("userId");
    const items = readLineItems(data);

    if (!userId) {
        return { status: "error", message: "Kein Konto ausgewählt." };
    }

    if (!items) {
        return {
            status: "error",
            message: "Mindestens eine Position mit gültiger Menge und Preis.",
        };
    }

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId))
                .for("update");

            if (row?.status !== "draft") {
                throw new Error("not-draft");
            }

            const contractId = read("contractId") || null;
            await assertContractBelongsTo(tx, contractId, userId);

            await tx
                .update(schema.invoice)
                .set({
                    userId,
                    contractId,
                    introText: read("introText") || null,
                    note: read("note") || null,
                    servicePeriodStart: parseDate(read("servicePeriodStart")),
                    servicePeriodEnd: parseDate(read("servicePeriodEnd")),
                    updatedAt: new Date(),
                })
                .where(eq(schema.invoice.id, invoiceId));

            await tx
                .delete(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, invoiceId));

            await tx.insert(schema.invoiceItem).values(
                items.map((item, index) => ({
                    id: createId("invoiceitem"),
                    invoiceId,
                    position: index + 1,
                    description: item.description,
                    detail: item.detail ?? null,
                    quantity: item.quantity,
                    unitCode: item.unitCode,
                    unitPriceCents: item.unitPriceCents,
                })),
            );
        });
    } catch (error) {
        console.error("[admin] updating invoice failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur Entwürfe können bearbeitet werden."
                    : error instanceof Error &&
                        error.message === "contract-mismatch"
                      ? "Der Vertrag gehört zu einem anderen Konto."
                      : "Die Rechnung konnte nicht gespeichert werden.",
        };
    }

    revalidatePath("/account/admin/invoices");
    revalidatePath(`/account/admin/invoices/${invoiceId}`);

    return { status: "saved" };
}

/**
 * A draft carries no number, so deleting it burns nothing and leaves no gap in
 * the RE- series that § 14 Abs. 4 Nr. 4 UStG requires to be unbroken. Anything
 * that has been issued is kept for the § 257 HGB / § 147 AO retention period
 * and is corrected by a Rechnungskorrektur instead.
 */
export async function deleteInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const invoiceId = String(data.get("invoiceId") ?? "");

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId))
                .for("update");

            if (row?.status !== "draft") {
                throw new Error("not-draft");
            }

            // invoice_item cascades, so the positions go with the row.
            await tx
                .delete(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId));
        });
    } catch (error) {
        console.error("[admin] deleting invoice failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur Entwürfe können gelöscht werden."
                    : "Die Rechnung konnte nicht gelöscht werden.",
        };
    }

    revalidatePath("/account/admin/invoices");

    // The detail page this runs from no longer has a row behind it.
    redirect("/account/admin/invoices");
}

/**
 * Issuing is the point of no return: the number required by § 14 Abs. 4 Nr. 4
 * UStG is assigned, the recipient and buyer reference are copied in, and the
 * document becomes read-only. The number comes from a counter locked inside
 * this transaction, so two concurrent issues cannot receive the same one.
 */
export async function issueInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const invoiceId = String(data.get("invoiceId") ?? "");

    let recipientEmail = "";
    let recipientName = "";

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId))
                .for("update");

            if (row?.status !== "draft") {
                throw new Error("not-draft");
            }

            const [buyer] = await tx
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, row.userId));

            const issuedAt = new Date();
            const dueAt = new Date(issuedAt);
            dueAt.setDate(dueAt.getDate() + policy.paymentTermDays);

            const number = await nextNumber(tx, "invoice", issuedAt);

            await tx
                .update(schema.invoice)
                .set({
                    number,
                    status: "issued",
                    issuedAt,
                    dueAt,
                    recipient: formatRecipient(buyer),
                    buyerReference:
                        buyer.buyerReference ??
                        String(buyer.customerNumber ?? buyer.id),
                    updatedAt: issuedAt,
                })
                .where(eq(schema.invoice.id, invoiceId));

            recipientEmail = buyer.email;
            recipientName = buyer.name;
        });
    } catch (error) {
        console.error("[admin] issuing invoice failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur Entwürfe können ausgestellt werden."
                    : "Die Rechnung konnte nicht ausgestellt werden.",
        };
    }

    // Sent outside the transaction: a mail failure must not roll back an
    // issued number, which would leave a gap and could hand it out twice.
    try {
        await sendInvoiceMail(invoiceId, recipientEmail, recipientName);
    } catch (error) {
        console.error("[admin] invoice issued but mail failed:", error);
        // Deliberately not revalidated: a refresh re-renders the row this
        // form lives in, unmounts it and takes the message with it. The
        // mutation is committed either way and the sentence below says so;
        // the next navigation picks up the new state.
        return {
            status: "error",
            message:
                "Die Rechnung ist ausgestellt, aber der E-Mail-Versand hat nicht geklappt. Sie liegt im Kundenbereich bereit.",
        };
    }

    revalidatePath("/account/admin/invoices");
    revalidatePath(`/account/admin/invoices/${invoiceId}`);
    revalidatePath("/account/invoices");

    return { status: "issued" };
}

/** Records the incoming payment. Only an issued invoice can be paid — marking
 *  a draft would leave a "paid" invoice without a number. */
export async function markInvoicePaid(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const invoiceId = String(data.get("invoiceId") ?? "");

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId))
                .for("update");

            if (row?.status !== "issued") {
                throw new Error("not-issued");
            }

            const paidAt = new Date();

            await tx
                .update(schema.invoice)
                .set({ status: "paid", paidAt, updatedAt: paidAt })
                .where(eq(schema.invoice.id, invoiceId));
        });
    } catch (error) {
        console.error("[admin] marking invoice paid failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-issued"
                    ? "Nur ausgestellte Rechnungen können als bezahlt markiert werden."
                    : "Die Zahlung konnte nicht vermerkt werden.",
        };
    }

    revalidatePath("/account/admin/invoices");
    revalidatePath(`/account/admin/invoices/${invoiceId}`);
    revalidatePath("/account/invoices");

    return { status: "saved" };
}

/** The counterpart for a payment booked by mistake or later reversed. The
 *  document itself is untouched — only the payment record is taken back. */
export async function unmarkInvoicePaid(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const invoiceId = String(data.get("invoiceId") ?? "");

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId))
                .for("update");

            if (row?.status !== "paid") {
                throw new Error("not-paid");
            }

            await tx
                .update(schema.invoice)
                .set({
                    status: "issued",
                    paidAt: null,
                    updatedAt: new Date(),
                })
                .where(eq(schema.invoice.id, invoiceId));
        });
    } catch (error) {
        console.error("[admin] unmarking invoice paid failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-paid"
                    ? "Nur bezahlte Rechnungen können zurückgesetzt werden."
                    : "Die Zahlung konnte nicht zurückgenommen werden.",
        };
    }

    revalidatePath("/account/admin/invoices");
    revalidatePath(`/account/admin/invoices/${invoiceId}`);
    revalidatePath("/account/invoices");

    return { status: "saved" };
}

/**
 * A correction is never an edit: AGB § 7 (7) — "Eine ausgestellte Rechnung
 * wird nicht verändert. Korrekturen erfolgen durch Stornierung und
 * Neuausstellung." So the correction is a full invoice of its own, drawn from
 * same RE- series, carrying the original's lines with reversed signs.
 *
 * Everything frozen at issue time — recipient, buyer reference, service period
 * — is copied verbatim rather than recomputed from the customer's master data:
 * the pair must add up to zero for the same parties the original named, even
 * if the customer has moved since.
 */
export async function cancelInvoice(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const invoiceId = String(data.get("invoiceId") ?? "");
    const correctionId = createId("invoice");

    let recipientEmail = "";
    let recipientName = "";

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId))
                .for("update");

            // A correction is itself an issued invoice, so "issued or paid"
            // would let one be reversed again into an endless chain.
            if (
                !row?.number ||
                row.cancelsInvoiceId ||
                (row.status !== "issued" && row.status !== "paid")
            ) {
                throw new Error("not-cancellable");
            }

            const [existing] = await tx
                .select({ id: schema.invoice.id })
                .from(schema.invoice)
                .where(eq(schema.invoice.cancelsInvoiceId, invoiceId));

            if (existing) {
                throw new Error("not-cancellable");
            }

            const items = await tx
                .select()
                .from(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, invoiceId))
                .orderBy(asc(schema.invoiceItem.position));

            const [buyer] = await tx
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, row.userId));

            const issuedAt = new Date();
            const number = await nextNumber(tx, "invoice", issuedAt);

            await tx.insert(schema.invoice).values({
                id: correctionId,
                userId: row.userId,
                contractId: row.contractId,
                number,
                status: "issued",
                recipient: row.recipient,
                buyerReference: row.buyerReference,
                issuedAt,
                // Nothing falls due on a correction; it settles the original.
                dueAt: null,
                servicePeriodStart: row.servicePeriodStart,
                servicePeriodEnd: row.servicePeriodEnd,
                cancelsInvoiceId: invoiceId,
                // The document already says what a correction does; the note
                // only has to name what it corrects, for the audit trail.
                note: `Korrektur zu Rechnung ${row.number}.`,
            });

            // The reversal sits on the quantity, not on the price: EN 16931
            // BR-27 forbids a negative item net price (BT-146), while a
            // negative invoiced quantity (BT-129) is exactly how a corrected
            // invoice is expressed. The line total comes out the same.
            await tx.insert(schema.invoiceItem).values(
                items.map((item, index) => ({
                    id: createId("invoiceitem"),
                    invoiceId: correctionId,
                    position: index + 1,
                    description: item.description,
                    detail: item.detail,
                    quantity: -item.quantity,
                    unitCode: item.unitCode,
                    unitPriceCents: item.unitPriceCents,
                })),
            );

            await tx
                .update(schema.invoice)
                .set({
                    status: "cancelled",
                    cancelledAt: issuedAt,
                    updatedAt: issuedAt,
                })
                .where(eq(schema.invoice.id, invoiceId));

            recipientEmail = buyer.email;
            recipientName = buyer.name;
        });
    } catch (error) {
        console.error("[admin] cancelling invoice failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-cancellable"
                    ? "Diese Rechnung kann nicht storniert werden."
                    : "Die Rechnung konnte nicht storniert werden.",
        };
    }

    // Outside the transaction: the correction carries a number of its own,
    // rolling it back over a failed mail would tear a gap into the series.
    try {
        await sendInvoiceMail(correctionId, recipientEmail, recipientName);
    } catch (error) {
        console.error("[admin] correction created but mail failed:", error);
        // Deliberately not revalidated: a refresh re-renders the row this
        // form lives in, unmounts it and takes the message with it. The
        // mutation is committed either way and the sentence below says so;
        // the next navigation picks up the new state.
        return {
            status: "error",
            message:
                "Die Rechnungskorrektur ist erstellt, aber der E-Mail-Versand hat nicht geklappt. Sie liegt im Kundenbereich bereit.",
        };
    }

    revalidatePath("/account/admin/invoices");
    revalidatePath(`/account/admin/invoices/${invoiceId}`);
    revalidatePath("/account/invoices");

    return { status: "cancelled", message: correctionId };
}

/**
 * Sends the document again, for a mail that bounced or never arrived. It reads
 * only: number, recipient and every other frozen field stay as they were, so
 * the customer receives the same document a second time, not a new one.
 */
export async function resendInvoiceMail(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const invoiceId = String(data.get("invoiceId") ?? "");

    try {
        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoiceId));

        // A cancelled invoice is annulled: sending it again would put a
        // payable document the customer no longer owes back in their inbox.
        // The correction itself is status "issued", so it stays resendable.
        if (
            !row?.number ||
            (row.status !== "issued" && row.status !== "paid")
        ) {
            throw new Error("not-issued");
        }

        const [buyer] = await db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, row.userId));

        await sendInvoiceMail(invoiceId, buyer.email, buyer.name);
    } catch (error) {
        console.error("[admin] resending invoice mail failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-issued"
                    ? "Nur ausgestellte Rechnungen können erneut versendet werden."
                    : "Der erneute Versand hat nicht geklappt.",
        };
    }

    return { status: "sent" };
}
