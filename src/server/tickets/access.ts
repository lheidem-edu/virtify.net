import "server-only";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { type Permission, staffCan } from "@/server/auth/permissions";
import { getStaffSession } from "@/server/auth/staff-session";
import { getCurrentCustomer } from "@/server/customers/current";
import { ANY_CUSTOMER, type CustomerScope } from "./repository";

/**
 * Who is asking for a ticket attachment.
 *
 * The same arrangement `src/server/documents/access.ts` has, and for the
 * same reason: one URL serves both the customer opening their own file and
 * the employee opening it from Verwaltung, so the route has to ask which of
 * the two is holding it.
 *
 * Two things are repeated here rather than shared, because getting either
 * wrong is a disclosure: an employee still needs the permission (404
 * otherwise, never 403), and they still need their second factor — these
 * are route handlers, so no admin layout runs in front of them.
 */
export async function ticketViewer(
    needed: Permission = "tickets.read",
): Promise<{ scope: CustomerScope; isAdmin: boolean }> {
    const staff = await getStaffSession();

    if (staff) {
        if (!staff.user.twoFactorEnabled) {
            redirect("/admin/two-factor/setup");
        }

        if (!(await staffCan(db, staff.user.id, needed))) {
            notFound();
        }

        return { scope: ANY_CUSTOMER, isAdmin: true };
    }

    const { customer } = await getCurrentCustomer();

    return { scope: customer.id, isAdmin: false };
}
