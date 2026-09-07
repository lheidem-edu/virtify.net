"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import {
    parseDate,
    parsePositivePriceToCents,
} from "@/lib/documents/line-items";
import { sendContractTerminationMail } from "@/lib/documents/send";

export type ContractState = {
    status:
        | "idle"
        | "created"
        | "saved"
        | "terminated"
        | "reactivated"
        | "error";
    message?: string;
};

const STATUSES = ["provisioning", "active", "terminated", "ended"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Which documents name this contract. Both links are what make a contract's
 * terms untouchable: an issued invoice bills them and an accepted offer is the
 * Vertragsschluss itself (§ 3 der AGB), so neither may be contradicted after
 * the fact. Called under the contract's row lock, so a document created in
 * parallel cannot slip between the check and the write.
 */
async function documentsFor(tx: Tx, contractId: string) {
    const [invoice] = await tx
        .select({ id: schema.invoice.id })
        .from(schema.invoice)
        .where(eq(schema.invoice.contractId, contractId))
        .limit(1);

    const [offer] = await tx
        .select({ id: schema.offer.id })
        .from(schema.offer)
        .where(eq(schema.offer.contractId, contractId))
        .limit(1);

    return { hasInvoices: Boolean(invoice), hasOffer: Boolean(offer) };
}

export async function createContract(
    _previous: ContractState,
    data: FormData,
): Promise<ContractState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const userId = read("userId");
    const title = read("title");
    const status = read("status");
    const cents = parsePositivePriceToCents(read("monthlyPrice"));
    const minimumTermMonths = Number.parseInt(read("minimumTermMonths"), 10);

    if (!userId || !title) {
        return {
            status: "error",
            message: "Konto und Bezeichnung sind Pflicht.",
        };
    }

    if (cents === null) {
        return {
            status: "error",
            message: "Die monatliche Vergütung ist keine gültige Zahl.",
        };
    }

    // AGB § 8 (1): die Grundlaufzeit beträgt höchstens zwölf Monate.
    if (
        !Number.isInteger(minimumTermMonths) ||
        minimumTermMonths < 0 ||
        minimumTermMonths > 12
    ) {
        return {
            status: "error",
            message: "Die Grundlaufzeit muss zwischen 0 und 12 Monaten liegen.",
        };
    }

    if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
        return { status: "error", message: "Unbekannter Status." };
    }

    const id = createId("contract");

    try {
        await db.insert(schema.contract).values({
            id,
            userId,
            // The visible number is the id itself, so support requests and
            // database rows always name the same thing.
            number: id,
            title,
            status: status as (typeof STATUSES)[number],
            serviceReadyAt: parseDate(read("serviceReadyAt")),
            minimumTermMonths,
            monthlyPriceCents: cents,
            terminatedTo: parseDate(read("terminatedTo")),
            note: read("note") || null,
        });
    } catch (error) {
        console.error("[admin] creating contract failed:", error);
        return {
            status: "error",
            message: "Der Vertrag konnte nicht angelegt werden.",
        };
    }

    revalidatePath("/account/admin/contracts");
    revalidatePath("/account/contracts");

    return { status: "created", message: id };
}

/**
 * Bezeichnung, Notiz, Status und Service-Readiness bleiben immer editierbar;
 * Vergütung und Grundlaufzeit nur, solange kein Dokument sie nennt. Eine
 * ausgestellte Rechnung liegt beim Kunden und darf nach § 14 UStG nicht
 * nachträglich widersprochen werden, und die Annahme eines Angebots ist nach
 * § 3 der AGB der Vertragsschluss über genau diese Konditionen.
 */
export async function updateContract(
    _previous: ContractState,
    data: FormData,
): Promise<ContractState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const contractId = String(data.get("contractId") ?? "");
    const title = read("title");
    const status = read("status");
    const cents = parsePositivePriceToCents(read("monthlyPrice"));
    const minimumTermMonths = Number.parseInt(read("minimumTermMonths"), 10);

    if (!title) {
        return { status: "error", message: "Die Bezeichnung ist Pflicht." };
    }

    if (cents === null) {
        return {
            status: "error",
            message: "Die monatliche Vergütung ist keine gültige Zahl.",
        };
    }

    // AGB § 8 (1): die Grundlaufzeit beträgt höchstens zwölf Monate.
    if (
        !Number.isInteger(minimumTermMonths) ||
        minimumTermMonths < 0 ||
        minimumTermMonths > 12
    ) {
        return {
            status: "error",
            message: "Die Grundlaufzeit muss zwischen 0 und 12 Monaten liegen.",
        };
    }

    if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
        return { status: "error", message: "Unbekannter Status." };
    }

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.contract)
                .where(eq(schema.contract.id, contractId))
                .for("update");

            if (!row) {
                throw new Error("not-found");
            }

            // Crossing into or out of "Gekündigt" belongs to Kündigen and
            // Kündigung zurücknehmen, which set and clear terminatedTo and
            // send the § 8 (4) confirmation. Reaching that state through the
            // plain status select would leave the date behind — terminated
            // without an end date, or active with a stale one. Running out
            // (terminated → beendet) is not that, and keeps the date as the
            // record of why the contract ended.
            const crossesTermination =
                status !== row.status &&
                ((status === "terminated" && row.status !== "ended") ||
                    (row.status === "terminated" && status !== "ended"));

            if (crossesTermination) {
                throw new Error("use-termination");
            }

            const changesTerms =
                row.monthlyPriceCents !== cents ||
                row.minimumTermMonths !== minimumTermMonths;

            if (changesTerms) {
                const documents = await documentsFor(tx, contractId);

                if (documents.hasInvoices || documents.hasOffer) {
                    throw new Error("already-billed");
                }
            }

            await tx
                .update(schema.contract)
                .set({
                    title,
                    status: status as (typeof STATUSES)[number],
                    serviceReadyAt: parseDate(read("serviceReadyAt")),
                    minimumTermMonths,
                    monthlyPriceCents: cents,
                    note: read("note") || null,
                    updatedAt: new Date(),
                })
                .where(eq(schema.contract.id, contractId));
        });
    } catch (error) {
        console.error("[admin] updating contract failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "already-billed"
                    ? "Vergütung und Laufzeit lassen sich nicht mehr ändern, sobald der Vertrag abgerechnet oder aus einem Angebot entstanden ist."
                    : error instanceof Error &&
                        error.message === "use-termination"
                      ? "Eine Kündigung wird über „Kündigen“ erfasst und über „Kündigung zurücknehmen“ aufgehoben — nur dort wird das Vertragsende gesetzt."
                      : "Der Vertrag konnte nicht gespeichert werden.",
        };
    }

    revalidatePath("/account/admin/contracts");
    revalidatePath(`/account/admin/contracts/${contractId}`);
    revalidatePath("/account/contracts");

    return { status: "saved" };
}

/**
 * § 8 (2) der AGB bestimmt nur den frühestmöglichen Termin — ein früheres
 * Vertragsende können die Parteien jederzeit vereinbaren, deshalb kommt das
 * Datum aus dem Formular und nicht aus der Rechnung. § 8 (4) schuldet dem
 * Kunden anschließend die Bestätigung in Textform, die genau dieses Datum
 * nennt.
 */
export async function terminateContract(
    _previous: ContractState,
    data: FormData,
): Promise<ContractState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const contractId = String(data.get("contractId") ?? "");
    const terminatedTo = parseDate(read("terminatedTo"));
    const notify = data.get("notify") !== null;

    if (!terminatedTo) {
        return {
            status: "error",
            message: "Das Vertragsende ist kein gültiges Datum.",
        };
    }

    let recipientEmail = "";

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.contract)
                .where(eq(schema.contract.id, contractId))
                .for("update");

            if (
                !row ||
                (row.status !== "provisioning" && row.status !== "active")
            ) {
                throw new Error("not-terminable");
            }

            await tx
                .update(schema.contract)
                .set({
                    status: "terminated",
                    terminatedTo,
                    updatedAt: new Date(),
                })
                .where(eq(schema.contract.id, contractId));

            const [buyer] = await tx
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, row.userId));

            recipientEmail = buyer.email;
        });
    } catch (error) {
        console.error("[admin] terminating contract failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-terminable"
                    ? "Nur laufende Verträge können gekündigt werden."
                    : "Der Vertrag konnte nicht gekündigt werden.",
        };
    }

    // Sent outside the transaction: a mail that fails must not roll back a
    // termination the customer may already be relying on.
    if (notify) {
        try {
            await sendContractTerminationMail(contractId, recipientEmail);
        } catch (error) {
            console.error(
                "[admin] contract terminated but mail failed:",
                error,
            );
            // Deliberately not revalidated: a refresh re-renders the row
            // this form lives in, unmounts it and takes the message with it.
            // The mutation is committed either way and the sentence below
            // says so; the next navigation picks up the new state.
            return {
                status: "error",
                message:
                    "Die Kündigung ist vermerkt, aber der E-Mail-Versand hat nicht geklappt. Das Vertragsende steht im Kundenbereich.",
            };
        }
    }

    revalidatePath("/account/admin/contracts");
    revalidatePath(`/account/admin/contracts/${contractId}`);
    revalidatePath("/account/contracts");

    return { status: "terminated" };
}

/**
 * Nimmt eine Kündigung zurück, die intern erfasst wurde. Ohne Mail: eine
 * Rücknahme wirkt nur, wenn beide Seiten sie tragen, also gehört die
 * Mitteilung an den Kunden in dieselbe Absprache, aus der sie stammt.
 */
export async function reactivateContract(
    _previous: ContractState,
    data: FormData,
): Promise<ContractState> {
    await requireAdmin();

    const contractId = String(data.get("contractId") ?? "");

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.contract)
                .where(eq(schema.contract.id, contractId))
                .for("update");

            if (row?.status !== "terminated") {
                throw new Error("not-terminated");
            }

            await tx
                .update(schema.contract)
                .set({
                    status: "active",
                    terminatedTo: null,
                    updatedAt: new Date(),
                })
                .where(eq(schema.contract.id, contractId));
        });
    } catch (error) {
        console.error("[admin] reactivating contract failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-terminated"
                    ? "Nur gekündigte Verträge können reaktiviert werden."
                    : "Die Kündigung konnte nicht zurückgenommen werden.",
        };
    }

    revalidatePath("/account/admin/contracts");
    revalidatePath(`/account/admin/contracts/${contractId}`);
    revalidatePath("/account/contracts");

    return { status: "reactivated" };
}

/**
 * Löschen ist nur möglich, solange kein Dokument auf den Vertrag zeigt:
 * invoice.contract_id und offer.contract_id sind ON DELETE SET NULL, ein
 * Löschen würde also stillschweigend den Bezug aus einer ausgestellten
 * Rechnung (§ 257 HGB, § 147 AO) und aus der Annahme des Angebots entfernen.
 */
export async function deleteContract(
    _previous: ContractState,
    data: FormData,
): Promise<ContractState> {
    await requireAdmin();

    const contractId = String(data.get("contractId") ?? "");

    try {
        await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(schema.contract)
                .where(eq(schema.contract.id, contractId))
                .for("update");

            if (!row) {
                throw new Error("not-found");
            }

            const documents = await documentsFor(tx, contractId);

            if (documents.hasInvoices) {
                throw new Error("has-invoices");
            }

            if (documents.hasOffer) {
                throw new Error("has-offer");
            }

            await tx
                .delete(schema.contract)
                .where(eq(schema.contract.id, contractId));
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        console.error("[admin] deleting contract failed:", error);

        return {
            status: "error",
            message:
                reason === "has-invoices"
                    ? "Der Vertrag hat Rechnungen und kann nicht gelöscht werden."
                    : reason === "has-offer"
                      ? "Der Vertrag ist aus einem Angebot entstanden und kann nicht gelöscht werden."
                      : "Der Vertrag konnte nicht gelöscht werden.",
        };
    }

    revalidatePath("/account/admin/contracts");
    revalidatePath("/account/contracts");

    // Outside the try/catch: redirect() is control flow, and the detail page
    // of a deleted contract no longer exists.
    redirect("/account/admin/contracts");
}
