"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import { parseDate, readLineItems } from "@/lib/documents/line-items";
import { nextNumber } from "@/lib/documents/numbering";
import { formatRecipient } from "@/lib/documents/repository";
import { sendInvoiceMail } from "@/lib/documents/send";
import { policy } from "@/lib/site";

export type InvoiceState = {
    status: "idle" | "created" | "issued" | "error";
    message?: string;
};

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
            await tx.insert(schema.invoice).values({
                id,
                userId,
                contractId: read("contractId") || null,
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
            message: "Die Rechnung konnte nicht angelegt werden.",
        };
    }

    revalidatePath("/account/admin/invoices");

    return { status: "created", message: id };
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
                    buyerReference: buyer.buyerReference ?? buyer.id,
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
        revalidatePath("/account/admin/invoices");
        return {
            status: "error",
            message:
                "Die Rechnung ist ausgestellt, aber der E-Mail-Versand hat nicht geklappt. Sie liegt im Kundenbereich bereit.",
        };
    }

    revalidatePath("/account/admin/invoices");
    revalidatePath("/account/invoices");

    return { status: "issued" };
}

/** Corrections happen by cancelling, never by editing an issued invoice. */
export async function setInvoiceState(
    _previous: InvoiceState,
    data: FormData,
): Promise<InvoiceState> {
    await requireAdmin();

    const invoiceId = String(data.get("invoiceId") ?? "");
    const action = String(data.get("action") ?? "");

    if (action !== "paid" && action !== "cancel") {
        return { status: "error", message: "Unbekannte Aktion." };
    }

    await db
        .update(schema.invoice)
        .set(
            action === "paid"
                ? { status: "paid", paidAt: new Date(), updatedAt: new Date() }
                : {
                      status: "cancelled",
                      cancelledAt: new Date(),
                      updatedAt: new Date(),
                  },
        )
        .where(eq(schema.invoice.id, invoiceId));

    revalidatePath("/account/admin/invoices");
    revalidatePath("/account/invoices");

    return { status: "issued" };
}
