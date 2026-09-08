import "server-only";
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { staffAuth } from "@/lib/staff-auth";
import { beginInvite, endInvite } from "@/lib/staff-invite";

/**
 * Creating and removing employee accounts. Sign-up is disabled on the staff
 * instance — an account exists because someone with access to Verwaltung, or
 * to the server, made it — so the rows are written through Better Auth's own
 * internals rather than an endpoint. That keeps the password hashing, the id
 * scheme and the credential linking identical to the customer side without
 * exposing a public way in.
 */

export type StaffAccount = {
    id: string;
    name: string;
    email: string;
    twoFactorEnabled: boolean;
    createdAt: Date;
};

export async function listStaffAccounts(): Promise<StaffAccount[]> {
    const rows = await db
        .select({
            id: schema.staffUser.id,
            name: schema.staffUser.name,
            email: schema.staffUser.email,
            twoFactorEnabled: schema.staffUser.twoFactorEnabled,
            createdAt: schema.staffUser.createdAt,
        })
        .from(schema.staffUser)
        .orderBy(asc(schema.staffUser.email));

    return rows.map((row) => ({
        ...row,
        twoFactorEnabled: row.twoFactorEnabled ?? false,
    }));
}

export async function findStaffAccount(email: string) {
    const [row] = await db
        .select({ id: schema.staffUser.id, email: schema.staffUser.email })
        .from(schema.staffUser)
        .where(eq(schema.staffUser.email, email.trim().toLowerCase()))
        .limit(1);

    return row ?? null;
}

/**
 * Creates the account with a password nobody knows. The invitation link is
 * what makes it usable, so control of the mailbox is what grants access —
 * and the address is marked as verified for the same reason: nothing else
 * could have opened the link.
 */
export async function createStaffAccount(input: {
    name: string;
    email: string;
}) {
    const context = await staffAuth.$context;
    const email = input.email.trim().toLowerCase();

    const user = await context.internalAdapter.createUser(
        {
            name: input.name.trim(),
            email,
            emailVerified: true,
        },
        { method: "invite" },
    );

    await context.internalAdapter.linkAccount({
        providerId: "credential",
        accountId: user.id,
        userId: user.id,
        password: await context.password.hash(
            randomBytes(24).toString("base64url"),
        ),
    });

    return user;
}

export async function removeStaffAccount(userId: string) {
    const context = await staffAuth.$context;
    await context.internalAdapter.deleteUser(userId);
}

/**
 * Sends the set-password link, worded as an invitation.
 * requestPasswordReset reports success either way — it must not confirm to a
 * stranger that an address exists — so the outcome comes back through the
 * invite record instead.
 */
export async function sendStaffInvite(email: string) {
    beginInvite(email);

    let outcome: ReturnType<typeof endInvite>;

    try {
        await staffAuth.api.requestPasswordReset({
            body: { email, redirectTo: "/admin/reset-password" },
        });
    } finally {
        outcome = endInvite(email);
    }

    if (!outcome.sent) {
        throw outcome.error ?? new Error("the invitation was never sent");
    }
}
