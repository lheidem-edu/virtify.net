"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import {
    parseDate,
    parsePositivePriceToCents,
    readLineItems,
} from "@/lib/documents/line-items";
import { nextNumber } from "@/lib/documents/numbering";
import { formatRecipient } from "@/lib/documents/repository";
import {
    sendOfferAcceptedMail,
    sendOfferMail,
    sendOfferWithdrawnMail,
} from "@/lib/documents/send";
import { requireStaff } from "@/lib/staff-session";

export type OfferState = {
    status:
        | "idle"
        | "created"
        | "updated"
        | "deleted"
        | "sent"
        | "done"
        | "error";
    message?: string;
};

/** § 8 (1) of the terms: a Grundlaufzeit beyond twelve months is never agreed. */
const MAXIMUM_TERM_MONTHS = 12;

/** Decisions the provider records for a customer who answered outside the portal. */
const RECORDED_DECISIONS = ["declined", "expired"] as const;

export async function createOffer(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireStaff();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const userId = read("userId");
    const title = read("title");
    const items = readLineItems(data);
    const monthlyCents = parsePositivePriceToCents(read("monthlyPrice") || "0");
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

    if (monthlyCents === null) {
        return { status: "error", message: "Der Monatspreis ist ungültig." };
    }

    if (
        !Number.isInteger(minimumTermMonths) ||
        minimumTermMonths < 0 ||
        minimumTermMonths > MAXIMUM_TERM_MONTHS
    ) {
        return {
            status: "error",
            message: "Die Grundlaufzeit beträgt höchstens zwölf Monate.",
        };
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
                    detail: item.detail,
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

    revalidatePath("/admin/offers");

    return { status: "created", message: id };
}

/**
 * Editing is confined to the draft: from the moment an offer is sent it is a
 * declaration the customer holds a copy of, and the PDF re-renders from these
 * rows on every download — a later edit would silently rewrite what was
 * received. The number stays as it was allocated, so an offer the customer
 * asks about keeps the name it was sent under.
 */
export async function updateOffer(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireStaff();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const offerId = String(data.get("offerId") ?? "");
    const userId = read("userId");
    const title = read("title");
    const items = readLineItems(data);
    const monthlyCents = parsePositivePriceToCents(read("monthlyPrice") || "0");
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

    if (monthlyCents === null) {
        return { status: "error", message: "Der Monatspreis ist ungültig." };
    }

    if (
        !Number.isInteger(minimumTermMonths) ||
        minimumTermMonths < 0 ||
        minimumTermMonths > MAXIMUM_TERM_MONTHS
    ) {
        return {
            status: "error",
            message: "Die Grundlaufzeit beträgt höchstens zwölf Monate.",
        };
    }

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.offer)
                .where(eq(schema.offer.id, offerId))
                .for("update");

            if (row?.status !== "draft") {
                throw new Error("not-draft");
            }

            await tx
                .update(schema.offer)
                .set({
                    userId,
                    title,
                    introText: read("introText") || null,
                    minimumTermMonths,
                    monthlyPriceCents: monthlyCents,
                    validUntil: parseDate(read("validUntil")),
                    note: read("note") || null,
                    updatedAt: new Date(),
                })
                .where(eq(schema.offer.id, offerId));

            // Positions are addressed by their dense order, so the set is
            // replaced wholesale rather than diffed row by row.
            await tx
                .delete(schema.offerItem)
                .where(eq(schema.offerItem.offerId, offerId));

            await tx.insert(schema.offerItem).values(
                items.map((item, index) => ({
                    id: createId("offeritem"),
                    offerId,
                    position: index + 1,
                    description: item.description,
                    detail: item.detail,
                    quantity: item.quantity,
                    unitCode: item.unitCode,
                    unitPriceCents: item.unitPriceCents,
                })),
            );
        });
    } catch (error) {
        console.error("[admin] updating offer failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur Entwürfe können bearbeitet werden."
                    : "Das Angebot konnte nicht gespeichert werden.",
        };
    }

    // A draft is invisible in the customer area, so only the admin views change.
    revalidatePath("/admin/offers");
    revalidatePath(`/admin/offers/${offerId}`);

    return { status: "updated" };
}

/**
 * Only a draft is disposable. Once sent, the offer is part of the record of
 * what was declared to the customer and stays even after it lapses; the
 * number it consumed is spent either way, because a gapless series is only
 * gapless if nothing ever reuses a number.
 */
export async function deleteOffer(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireStaff();

    const offerId = String(data.get("offerId") ?? "");

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.offer)
                .where(eq(schema.offer.id, offerId))
                .for("update");

            if (row?.status !== "draft") {
                throw new Error("not-draft");
            }

            await tx.delete(schema.offer).where(eq(schema.offer.id, offerId));
        });
    } catch (error) {
        console.error("[admin] deleting offer failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur Entwürfe können gelöscht werden."
                    : "Das Angebot konnte nicht gelöscht werden.",
        };
    }

    revalidatePath("/admin/offers");

    // The detail route the delete was triggered from no longer resolves.
    redirect("/admin/offers");
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
    await requireStaff();

    const offerId = String(data.get("offerId") ?? "");

    let recipientEmail = "";
    let recipientName = "";

    try {
        await db.transaction(async (tx) => {
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

            const sentAt = new Date();

            await tx
                .update(schema.offer)
                .set({
                    status: "sent",
                    sentAt,
                    recipient: formatRecipient(buyer),
                    updatedAt: sentAt,
                })
                .where(eq(schema.offer.id, offerId));

            recipientEmail = buyer.email;
            recipientName = buyer.name;
        });
    } catch (error) {
        console.error("[admin] sending offer failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur Entwürfe können versendet werden."
                    : "Das Angebot konnte nicht versendet werden.",
        };
    }

    // Sent outside the transaction: the offer is already in the customer area
    // and open for acceptance, so a failing mail must not roll that back.
    try {
        await sendOfferMail(offerId, recipientEmail, recipientName);
    } catch (error) {
        console.error("[admin] offer sent but mail failed:", error);
        // Deliberately not revalidated: a refresh re-renders the row this
        // form lives in, unmounts it and takes the message with it. The
        // mutation is committed either way and the sentence below says so;
        // the next navigation picks up the new state.
        return {
            status: "error",
            message:
                "Das Angebot ist versendet, aber der E-Mail-Versand hat nicht geklappt. Es liegt im Kundenbereich bereit.",
        };
    }

    revalidatePath("/admin/offers");
    revalidatePath(`/admin/offers/${offerId}`);
    revalidatePath("/account/offers");

    return { status: "sent" };
}

/** Another copy of the same offer — nothing about the document changes. */
export async function resendOfferMail(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireStaff();

    const offerId = String(data.get("offerId") ?? "");

    const [row] = await db
        .select()
        .from(schema.offer)
        .where(eq(schema.offer.id, offerId));

    if (row?.status !== "sent") {
        return {
            status: "error",
            message: "Nur versendete Angebote können erneut versendet werden.",
        };
    }

    const [buyer] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, row.userId));

    try {
        await sendOfferMail(offerId, buyer.email, buyer.name);
    } catch (error) {
        console.error("[admin] resending offer mail failed:", error);
        return {
            status: "error",
            message: "Der erneute Versand hat nicht geklappt.",
        };
    }

    return { status: "sent" };
}

/**
 * Pulling an offer back before it is accepted. § 8 (4) of the terms puts every
 * declaration about a contract in Textform, and an offer the customer can
 * still see and click in the portal deserves the same — hence the mail, which
 * only an operator who has already told them by hand switches off.
 */
export async function withdrawOffer(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireStaff();

    const offerId = String(data.get("offerId") ?? "");
    const notify = String(data.get("notify") ?? "") === "yes";

    let recipientEmail = "";

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.offer)
                .where(eq(schema.offer.id, offerId))
                .for("update");

            if (row?.status !== "sent") {
                throw new Error("not-sent");
            }

            const [buyer] = await tx
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, row.userId));

            const decidedAt = new Date();

            await tx
                .update(schema.offer)
                .set({
                    status: "withdrawn",
                    decidedAt,
                    updatedAt: decidedAt,
                })
                .where(eq(schema.offer.id, offerId));

            recipientEmail = buyer.email;
        });
    } catch (error) {
        console.error("[admin] withdrawing offer failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-sent"
                    ? "Nur versendete Angebote können zurückgezogen werden."
                    : "Das Angebot konnte nicht zurückgezogen werden.",
        };
    }

    // Outside the transaction: the offer is already closed for acceptance, and
    // a failing mail must not hand it back to the customer.
    if (notify) {
        try {
            await sendOfferWithdrawnMail(offerId, recipientEmail);
        } catch (error) {
            console.error("[admin] offer withdrawn but mail failed:", error);
            // Deliberately not revalidated: a refresh re-renders the row
            // this form lives in, unmounts it and takes the message with it.
            // The mutation is committed either way and the sentence below
            // says so; the next navigation picks up the new state.
            return {
                status: "error",
                message:
                    "Das Angebot ist zurückgezogen, aber der E-Mail-Versand hat nicht geklappt. Bitte den Kunden von Hand informieren.",
            };
        }
    }

    revalidatePath("/admin/offers");
    revalidatePath(`/admin/offers/${offerId}`);
    revalidatePath("/account/offers");

    return { status: "done" };
}

/**
 * Records an answer the customer gave outside the portal, or the lapse of an
 * offer nobody answered at all. Both are entries in the record, not
 * declarations of our own, so neither sends anything: a refusal the customer
 * spoke on the phone is not made truer by mailing it back to them.
 */
export async function setOfferDecision(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireStaff();

    const offerId = String(data.get("offerId") ?? "");
    const decision = String(data.get("decision") ?? "").trim();

    if (
        !RECORDED_DECISIONS.includes(
            decision as (typeof RECORDED_DECISIONS)[number],
        )
    ) {
        return { status: "error", message: "Unbekannte Aktion." };
    }

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.offer)
                .where(eq(schema.offer.id, offerId))
                .for("update");

            if (row?.status !== "sent") {
                throw new Error("not-sent");
            }

            const decidedAt = new Date();

            await tx
                .update(schema.offer)
                .set({
                    status: decision as (typeof RECORDED_DECISIONS)[number],
                    decidedAt,
                    updatedAt: decidedAt,
                })
                .where(eq(schema.offer.id, offerId));
        });
    } catch (error) {
        console.error("[admin] recording offer decision failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-sent"
                    ? "Nur versendete Angebote können entschieden werden."
                    : "Die Entscheidung konnte nicht gespeichert werden.",
        };
    }

    revalidatePath("/admin/offers");
    revalidatePath(`/admin/offers/${offerId}`);
    revalidatePath("/account/offers");

    return { status: "done" };
}

/**
 * Acceptance declared by phone or mail, recorded here so the customer does not
 * have to log in to click it. It does what the customer's own acceptance does
 * and nothing besides: § 3 of the terms makes the acceptance the
 * Vertragsschluss, so the contract has to come into being in the same
 * transaction — an accepted offer without its contract would leave the
 * customer bound to something that does not exist.
 *
 * The confirmation afterwards is not a courtesy: the customer must hold the
 * record of a contract concluded on their behalf in Textform, and for a
 * consumer that document is what the § 355 BGB withdrawal period is measured
 * against.
 */
export async function acceptOfferForCustomer(
    _previous: OfferState,
    data: FormData,
): Promise<OfferState> {
    await requireStaff();

    const offerId = String(data.get("offerId") ?? "");
    const notify = String(data.get("notify") ?? "") === "yes";

    let recipientEmail = "";

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.offer)
                .where(eq(schema.offer.id, offerId))
                .for("update");

            // Only a sent offer can be decided, and only once — a double
            // submit must not produce a second contract.
            if (row?.status !== "sent") {
                throw new Error("not-sent");
            }

            if (row.validUntil && row.validUntil < new Date()) {
                throw new Error("expired");
            }

            const [buyer] = await tx
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, row.userId));

            const contractId = createId("contract");
            const decidedAt = new Date();

            await tx.insert(schema.contract).values({
                id: contractId,
                number: contractId,
                userId: row.userId,
                title: row.title,
                status: "provisioning",
                minimumTermMonths: row.minimumTermMonths,
                monthlyPriceCents: row.monthlyPriceCents,
                note: `Aus Angebot ${row.number} angenommen. Die Annahme wurde außerhalb des Kundenbereichs erklärt und vom Anbieter erfasst.`,
            });

            await tx
                .update(schema.offer)
                .set({
                    status: "accepted",
                    decidedAt,
                    contractId,
                    updatedAt: decidedAt,
                })
                .where(eq(schema.offer.id, offerId));

            recipientEmail = buyer.email;
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        console.error("[admin] accepting offer for customer failed:", error);

        return {
            status: "error",
            message:
                reason === "expired"
                    ? "Dieses Angebot ist abgelaufen und kann nicht mehr angenommen werden."
                    : reason === "not-sent"
                      ? "Nur versendete Angebote können angenommen werden."
                      : "Das Angebot konnte nicht angenommen werden.",
        };
    }

    // Outside the transaction: the contract exists either way, and rolling it
    // back over a mail server would undo a Vertragsschluss that was declared.
    if (notify) {
        try {
            await sendOfferAcceptedMail(offerId, recipientEmail);
        } catch (error) {
            console.error("[admin] offer accepted but mail failed:", error);
            // Deliberately not revalidated: a refresh re-renders the row
            // this form lives in, unmounts it and takes the message with it.
            // The mutation is committed either way and the sentence below
            // says so; the next navigation picks up the new state.
            return {
                status: "error",
                message:
                    "Der Vertrag ist angelegt, aber die Auftragsbestätigung hat nicht geklappt. Bitte den Kunden von Hand bestätigen.",
            };
        }
    }

    revalidateAfterAcceptance(offerId);

    return { status: "done" };
}

/** Acceptance touches an offer, a contract and both overviews at once. */
function revalidateAfterAcceptance(offerId: string) {
    revalidatePath("/admin/offers");
    revalidatePath(`/admin/offers/${offerId}`);
    revalidatePath("/admin/contracts");
    revalidatePath("/account/offers");
    revalidatePath("/account/contracts");
    revalidatePath("/account");
}
