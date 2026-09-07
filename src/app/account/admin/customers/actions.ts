"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";

export type CustomerState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

const FIELDS = [
    "name",
    "company",
    "street",
    "postalCode",
    "city",
    "country",
    "vatId",
    "phone",
    "buyerReference",
] as const;

/**
 * Corrects a customer's master data. Deliberately cannot change the email
 * address or the role: the address is the login and is only ever changed by
 * the customer with confirmation, and roles are granted at the server.
 */
export async function updateCustomer(
    _previous: CustomerState,
    data: FormData,
): Promise<CustomerState> {
    await requireAdmin();

    const userId = String(data.get("userId") ?? "");

    if (!userId) {
        return { status: "error", message: "Kein Konto angegeben." };
    }

    const [target] = await db
        .select({ role: schema.user.role })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
        .limit(1);

    if (!target) {
        return { status: "error", message: "Konto nicht gefunden." };
    }

    // An employee has no master data to correct, and the database would
    // refuse the write anyway — better a sentence than a stack trace.
    if (target.role === "admin") {
        return {
            status: "error",
            message: "Mitarbeiterkonten haben keine Stammdaten.",
        };
    }

    const values: Record<string, string | null> = {};

    for (const field of FIELDS) {
        const raw = String(data.get(field) ?? "").trim();

        if (raw.length > 200) {
            return { status: "error", message: "Eine Angabe ist zu lang." };
        }

        values[field] = raw === "" ? null : raw;
    }

    if (!values.name) {
        return { status: "error", message: "Der Name ist erforderlich." };
    }

    await db
        .update(schema.user)
        .set({ ...values, name: values.name, updatedAt: new Date() })
        .where(eq(schema.user.id, userId));

    revalidatePath("/account/admin/customers");

    return { status: "saved" };
}
