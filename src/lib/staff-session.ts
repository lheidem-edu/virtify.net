import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { staffAuth } from "@/lib/staff-auth";

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
