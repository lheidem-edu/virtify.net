import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import {
    hasPermission,
    type Permission,
    permissionsForStaff,
} from "@/server/auth/permissions";
import { staffAuth } from "@/server/auth/staff-auth";

/**
 * The employee's session for the current request. Entirely separate from the
 * customer's: a different cookie, a different table, a different password.
 * Holding one says nothing about the other, which is the point — the same
 * person can be signed in as both at once.
 */
export async function getStaffSession() {
    return staffAuth.api.getSession({ headers: await headers() });
}

/**
 * Guard for everything under /admin that is not the door itself. A staff
 * session that has not set up two-factor is sent to do so: the account reads
 * every customer's data, and an invitation mail asking nicely is not the same
 * as a requirement.
 */
export async function requireStaff() {
    const session = await requireStaffSession();

    if (!session.user.twoFactorEnabled) {
        redirect("/admin/two-factor/setup");
    }

    return session;
}

/**
 * The same guard without the two-factor gate — for the pages that exist to
 * get past it, and nowhere else.
 */
export async function requireStaffSession() {
    const session = await getStaffSession();

    if (!session) {
        redirect("/admin/login");
    }

    return session;
}

/**
 * The permissions of the employee making this request, read once however
 * often a page asks. `cache` is per request, so a page that guards three
 * sections does not run three queries.
 */
export const currentStaffPermissions = cache(async (): Promise<string[]> => {
    const session = await requireStaff();

    return permissionsForStaff(db, session.user.id);
});

export async function currentStaffCan(needed: Permission): Promise<boolean> {
    return hasPermission(await currentStaffPermissions(), needed);
}

/**
 * The guard for a page or a server action. Refusal is a redirect rather than
 * an exception: a page would otherwise render the error boundary, and an
 * employee who opened a section they may not see should be told so, not shown
 * a stack trace.
 *
 * Services keep their own check — `assertStaffPermission` in
 * ./permissions.ts — because this one only knows about the current request.
 */
export async function requirePermission(needed: Permission) {
    const session = await requireStaff();

    if (!hasPermission(await currentStaffPermissions(), needed)) {
        redirect(`/admin/denied?permission=${encodeURIComponent(needed)}`);
    }

    return session;
}
