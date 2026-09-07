"use server";

import { randomBytes } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { beginInvite, endInvite } from "@/lib/staff-invite";

/**
 * Employee accounts. They are created here rather than by promoting a
 * customer, which is what keeps them free of a customer number and master
 * data from the first moment — see the check constraint on `user`.
 *
 * An invitation is Better Auth's password-reset link: the account is created
 * with a password nobody knows, so the only way in is the mail sent to the
 * address that was typed. Whoever controls that mailbox controls the account,
 * which is the same promise every invitation makes.
 */

export type StaffState = {
    status: "idle" | "invited" | "removed" | "error";
    message?: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Better Auth reports its refusals as APIError; only the message is useful. */
function reason(error: unknown, fallback: string) {
    const detail = error as { body?: { message?: string }; message?: string };
    return detail?.body?.message ?? detail?.message ?? fallback;
}

/**
 * Sends the set-password link, worded as an invitation. requestPasswordReset
 * reports success either way — it must not confirm to a stranger that an
 * address exists — so the outcome comes back through the invite record.
 */
async function sendInvite(email: string) {
    beginInvite(email);

    let outcome: ReturnType<typeof endInvite>;

    try {
        await auth.api.requestPasswordReset({
            body: { email, redirectTo: "/account/reset-password" },
        });
    } finally {
        outcome = endInvite(email);
    }

    if (!outcome.sent) {
        throw outcome.error ?? new Error("the invitation was never sent");
    }
}

export async function inviteStaff(
    _previous: StaffState,
    data: FormData,
): Promise<StaffState> {
    await requireAdmin();

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

    const [existing] = await db
        .select({ role: schema.user.role })
        .from(schema.user)
        .where(eq(schema.user.email, email))
        .limit(1);

    if (existing) {
        return {
            status: "error",
            message:
                existing.role === "admin"
                    ? "Für diese Adresse gibt es bereits einen Mitarbeiterzugang."
                    : "Diese Adresse gehört zu einem Kundenkonto. Ein Zugang braucht eine eigene Adresse.",
        };
    }

    try {
        await auth.api.createUser({
            headers: await headers(),
            body: {
                email,
                name,
                // Never used and never disclosed: the invitation link is the
                // only way in, and it sets a password of the employee's own.
                password: randomBytes(24).toString("base64url"),
                role: "admin",
                // The invitation goes to this address and nothing else grants
                // access, so confirming it separately would ask the same
                // question twice.
                data: { emailVerified: true },
            },
        });
    } catch (error) {
        console.error("[staff] creating the account failed:", error);
        return {
            status: "error",
            message: reason(error, "Der Zugang konnte nicht angelegt werden."),
        };
    }

    try {
        await sendInvite(email);
    } catch (error) {
        console.error("[staff] sending the invitation failed:", error);
        revalidatePath("/account/admin/staff");
        return {
            status: "error",
            message: `Der Zugang für ${email} wurde angelegt, die Einladung konnte aber nicht zugestellt werden. Über „Einladung erneut senden“ noch einmal versuchen.`,
        };
    }

    revalidatePath("/account/admin/staff");
    return { status: "invited", message: `Einladung an ${email} gesendet.` };
}

export async function resendInvite(
    _previous: StaffState,
    data: FormData,
): Promise<StaffState> {
    await requireAdmin();

    const userId = String(data.get("userId") ?? "");

    const [target] = await db
        .select({ email: schema.user.email, role: schema.user.role })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
        .limit(1);

    if (target?.role !== "admin") {
        return { status: "error", message: "Kein Mitarbeiterzugang." };
    }

    try {
        await sendInvite(target.email);
    } catch (error) {
        console.error("[staff] sending the invitation failed:", error);
        return {
            status: "error",
            message: reason(
                error,
                "Die Einladung konnte nicht zugestellt werden.",
            ),
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
    const session = await requireAdmin();

    const userId = String(data.get("userId") ?? "");

    if (userId === session.user.id) {
        return {
            status: "error",
            message:
                "Der eigene Zugang lässt sich hier nicht entfernen — dafür braucht es einen zweiten Mitarbeiter.",
        };
    }

    const [target] = await db
        .select({ email: schema.user.email, role: schema.user.role })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
        .limit(1);

    if (target?.role !== "admin") {
        return { status: "error", message: "Kein Mitarbeiterzugang." };
    }

    const remaining = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(and(eq(schema.user.role, "admin"), ne(schema.user.id, userId)))
        .limit(1);

    if (remaining.length === 0) {
        return {
            status: "error",
            message:
                "Das ist der letzte Zugang zur Verwaltung; er kann nicht entfernt werden.",
        };
    }

    try {
        await auth.api.removeUser({
            headers: await headers(),
            body: { userId },
        });
    } catch (error) {
        console.error("[staff] removing the account failed:", error);
        return {
            status: "error",
            message: reason(error, "Der Zugang konnte nicht entfernt werden."),
        };
    }

    revalidatePath("/account/admin/staff");
    return { status: "removed", message: `${target.email} wurde entfernt.` };
}
