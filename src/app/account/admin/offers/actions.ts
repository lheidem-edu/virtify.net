"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import {
    parseDate,
    parsePriceToCents,
    readLineItems,
} from "@/lib/documents/line-items";
import { nextNumber } from "@/lib/documents/numbering";
import { formatRecipient } from "@/lib/documents/repository";
import { sendOfferMail } from "@/lib/documents/send";

export type OfferState = {
    status: "idle" | "created" | "sent" | "error";
    message?: string;
};

export async function createOffer(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const userId = read("userId");
    const title = read("title");
    const items = readLineItems(data);
    const monthlyCents = parsePriceToCents(read("monthlyPrice") || "0");
    const minimumTermMonths = Number.parseInt(read("minimumTermMonths"), 10);

    if (!userId || !title) {
        return { status: "error", message: "Konto und Titel sind Pflicht." };
    }

    if (!items) {
        return {
            status: "error",
            message: "Mindestens eine Position mit gültiger Menge und Preis.",
        };
    }

    if (monthlyCents === null || !Number.isInteger(minimumTermMonths)) {
        return { status: "error", message: "Laufzeit oder Preis ungültig." };
    }

    const id = createId("offer");

    try {
        await db.transaction(async (tx) => {
            const number = await nextNumber(tx, "offer", new Date());

            await tx.insert(schema.offer).values({
                id,
                userId,
                number,
                title,
                status: "draft",
                introText: read("introText") || null,
                minimumTermMonths,
                monthlyPriceCents: monthlyCents,
                validUntil: parseDate(read("validUntil")),
                note: read("note") || null,
            });

            await tx.insert(schema.offerItem).values(
                items.map((item, index) => ({
                    id: createId("offeritem"),
                    offerId: id,
                    position: index + 1,
                    description: item.description,
                    quantity: item.quantity,
                    unitCode: item.unitCode,
                    unitPriceCents: item.unitPriceCents,
                })),
            );
        });
    } catch (error) {
        console.error("[admin] creating offer failed:", error);
        return {
            status: "error",
            message: "Das Angebot konnte nicht angelegt werden.",
        };
    }

    revalidatePath("/account/admin/offers");

    return { status: "created", message: id };
}

/**
 * Sending freezes the recipient block and hands the offer to the customer.
 * The address is copied rather than referenced so a later change of address
 * cannot rewrite a document that was already sent.
 */
export async function sendOffer(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireAdmin();

    const offerId = String(data.get("offerId") ?? "");

    try {
        const sent = await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.offer)
                .where(eq(schema.offer.id, offerId))
                .for("update");

            if (row?.status !== "draft") {
                throw new Error("not-draft");
            }

            const [buyer] = await tx
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, row.userId));

            await tx
                .update(schema.offer)
                .set({
                    status: "sent",
                    sentAt: new Date(),
                    recipient: formatRecipient(buyer),
                    updatedAt: new Date(),
                })
                .where(eq(schema.offer.id, offerId));

            return { offerId, email: buyer.email, name: buyer.name };
        });

        await sendOfferMail(sent.offerId, sent.email, sent.name);
    } catch (error) {
        console.error("[admin] sending offer failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur Entwürfe können versendet werden."
                    : "Der Versand hat nicht geklappt. Das Angebot ist versendet, aber die E-Mail ging nicht raus.",
        };
    }

    revalidatePath("/account/admin/offers");
    revalidatePath("/account/offers");

    return { status: "sent" };
}
