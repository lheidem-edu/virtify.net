"use server";

import { eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db";
import {
    createStaffAccount,
    findStaffAccount,
    removeStaffAccount,
    sendStaffInvite,
} from "@/lib/staff-accounts";
import { requireStaff } from "@/lib/staff-session";

/**
 * Employee accounts. They live on their own tables with their own passwords,
 * so the same address can be an employee here and a customer in the
 * Kundenbereich without the two having anything to do with each other.
 */

export type StaffState = {
    status: "idle" | "invited" | "removed" | "error";
    message?: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function inviteStaff(
    _previous: StaffState,
    data: FormData,
): Promise<StaffState> {
    await requireStaff();

    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("email") ?? "")
        .trim()
        .toLowerCase();

    if (!name || name.length > 200) {
        return { status: "error", message: "Bitte einen Namen angeben." };
    }

    if (!EMAIL.test(email)) {
        return {
            status: "error",
            message: "Bitte eine gültige E-Mail-Adresse angeben.",
        };
    }

    if (await findStaffAccount(email)) {
        return {
            status: "error",
            message: "Für diese Adresse gibt es bereits einen Zugang.",
        };
    }

    try {
        await createStaffAccount({ name, email });
    } catch (error) {
        console.error("[staff] creating the account failed:", error);
        return {
            status: "error",
            message: "Der Zugang konnte nicht angelegt werden.",
        };
    }

    revalidatePath("/admin/staff");

    try {
        await sendStaffInvite(email);
    } catch (error) {
        console.error("[staff] sending the invitation failed:", error);
        return {
            status: "error",
            message: `Der Zugang für ${email} wurde angelegt, die Einladung konnte aber nicht zugestellt werden. Über „Einladung erneut senden“ noch einmal versuchen.`,
        };
    }

    return { status: "invited", message: `Einladung an ${email} gesendet.` };
}

export async function resendInvite(
    _previous: StaffState,
    data: FormData,
): Promise<StaffState> {
    await requireStaff();

    const [target] = await db
        .select({ email: schema.staffUser.email })
        .from(schema.staffUser)
        .where(eq(schema.staffUser.id, String(data.get("userId") ?? "")))
        .limit(1);

    if (!target) {
        return { status: "error", message: "Kein Zugang gefunden." };
    }

    try {
        await sendStaffInvite(target.email);
    } catch (error) {
        console.error("[staff] sending the invitation failed:", error);
        return {
            status: "error",
            message: "Die Einladung konnte nicht zugestellt werden.",
        };
    }

    return {
        status: "invited",
        message: `Einladung an ${target.email} erneut gesendet.`,
    };
}

export async function removeStaff(
    _previous: StaffState,
    data: FormData,
): Promise<StaffState> {
    const session = await requireStaff();

    const userId = String(data.get("userId") ?? "");

    if (userId === session.user.id) {
        return {
            status: "error",
            message:
                "Der eigene Zugang lässt sich hier nicht entfernen — dafür braucht es einen zweiten Mitarbeiter.",
        };
    }

    const [target] = await db
        .select({ email: schema.staffUser.email })
        .from(schema.staffUser)
        .where(eq(schema.staffUser.id, userId))
        .limit(1);

    if (!target) {
        return { status: "error", message: "Kein Zugang gefunden." };
    }

    const remaining = await db
        .select({ id: schema.staffUser.id })
        .from(schema.staffUser)
        .where(ne(schema.staffUser.id, userId))
        .limit(1);

    if (remaining.length === 0) {
        return {
            status: "error",
            message:
                "Das ist der letzte Zugang zur Verwaltung; er kann nicht entfernt werden.",
        };
    }

    try {
        await removeStaffAccount(userId);
    } catch (error) {
        console.error("[staff] removing the account failed:", error);
        return {
            status: "error",
            message: "Der Zugang konnte nicht entfernt werden.",
        };
    }

    revalidatePath("/admin/staff");
    return { status: "removed", message: `${target.email} wurde entfernt.` };
}
