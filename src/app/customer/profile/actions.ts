"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";

export type ProfileState = {
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
] as const;

const MAX_LENGTH = 200;

export async function updateProfile(
    _previous: ProfileState,
    data: FormData,
): Promise<ProfileState> {
    const session = await requireSession();

    const values: Record<string, string | null> = {};

    for (const field of FIELDS) {
        const raw = String(data.get(field) ?? "").trim();

        if (raw.length > MAX_LENGTH) {
            return {
                status: "error",
                message: "Eine der Angaben ist zu lang.",
            };
        }

        // Empty means "not provided" rather than an empty string, so the
        // overview can tell missing data from a blank field.
        values[field] = raw === "" ? null : raw;
    }

    if (!values.name) {
        return { status: "error", message: "Bitte gib deinen Namen an." };
    }

    await db
        .update(schema.user)
        .set({ ...values, name: values.name, updatedAt: new Date() })
        .where(eq(schema.user.id, session.user.id));

    revalidatePath("/customer");
    revalidatePath("/customer/profile");

    return { status: "saved" };
}
