"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { SETTINGS_ID } from "@/lib/settings";

export type SettingsState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

const TEXT_FIELDS = [
    "siteName",
    "siteUrl",
    "tagline",
    "description",
    "operatorName",
    "operatorStreet",
    "operatorCity",
    "operatorCountry",
    "operatorEmail",
    "operatorVatId",
    "operatorPhone",
    "bankName",
    "bankIban",
    "bankBic",
] as const;

const NUMBER_FIELDS = [
    "logRetentionDays",
    "paymentTermDays",
    "dataRetrievalDays",
    "securityMaintenanceNoticeHours",
] as const;

/**
 * The operator's own details. Everything here is quoted somewhere a customer
 * reads — the Impressum, an invoice, a mail footer — so it is all required:
 * an empty field would leave a hole in a document rather than a shorter one.
 */
export async function saveSettings(
    _previous: SettingsState,
    data: FormData,
): Promise<SettingsState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const values: Record<string, string | number> = {};

    for (const field of TEXT_FIELDS) {
        const value = read(field);

        if (!value) {
            return {
                status: "error",
                message:
                    "Alle Felder sind Pflicht — jedes steht in einem Dokument.",
            };
        }

        values[field] = value;
    }

    if (!/^https?:\/\//.test(String(values.siteUrl))) {
        return {
            status: "error",
            message: "Die Adresse der Website braucht http:// oder https://.",
        };
    }

    if (!String(values.operatorEmail).includes("@")) {
        return { status: "error", message: "Die E-Mail-Adresse ist ungültig." };
    }

    for (const field of NUMBER_FIELDS) {
        const value = Number.parseInt(read(field), 10);

        if (!Number.isInteger(value) || value < 0) {
            return {
                status: "error",
                message: "Die Fristen müssen ganze Zahlen ab null sein.",
            };
        }

        values[field] = value;
    }

    try {
        await db
            .insert(schema.siteSetting)
            .values({
                id: SETTINGS_ID,
                ...values,
            } as typeof schema.siteSetting.$inferInsert)
            .onConflictDoUpdate({
                target: schema.siteSetting.id,
                set: { ...values, updatedAt: new Date() },
            });
    } catch (error) {
        console.error("[admin] saving the settings failed:", error);
        return {
            status: "error",
            message: "Die Einstellungen konnten nicht gespeichert werden.",
        };
    }

    // Everything quotes these: the public pages, the documents, the mails.
    revalidatePath("/", "layout");

    return { status: "saved", message: "Gespeichert." };
}
