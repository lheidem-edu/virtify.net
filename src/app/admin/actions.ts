"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";

export type ContractState = {
    status: "idle" | "created" | "error";
    message?: string;
};

const STATUSES = ["provisioning", "active", "terminated", "ended"] as const;

function parseDate(value: string) {
    if (!value) {
        return null;
    }

    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Accepts "9,95" as well as "9.95" — German input is the common case here. */
function parsePriceToCents(value: string) {
    const normalised = value.replace(/\s/g, "").replace(",", ".");

    if (!/^\d+(\.\d{1,2})?$/.test(normalised)) {
        return null;
    }

    return Math.round(Number(normalised) * 100);
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
    const cents = parsePriceToCents(read("monthlyPrice"));
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

    if (!Number.isInteger(minimumTermMonths) || minimumTermMonths < 0) {
        return { status: "error", message: "Die Grundlaufzeit ist ungültig." };
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

    revalidatePath("/admin");
    revalidatePath("/customer");

    return { status: "created", message: id };
}
