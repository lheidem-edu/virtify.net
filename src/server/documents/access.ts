import "server-only";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import type { Permission } from "@/server/auth/permissions";
import { staffCan } from "@/server/auth/permissions";
import { getStaffSession } from "@/server/auth/staff-session";
import { getCurrentCustomer } from "@/server/customers/current";
import { ANY_CUSTOMER } from "@/server/documents/repository";

/**
 * Who is asking for a document. The PDF and XML routes are the one place both
 * sides meet: a customer opens their own invoice from the Kundenbereich, and
 * an employee opens the same document from Verwaltung. There is one URL for
 * it, so the route asks here which of the two is holding it.
 *
 * The staff session wins when both cookies are present — that is a person
 * looking at the document as an employee, and the customer view is the one
 * they can reach without it.
 *
 * An employee still has to hold the permission for the kind of document they
 * are asking for (CLAUDE.md rule 5). Without it the answer is 404, the same
 * one a stranger gets — a 403 would confirm the document exists.
 *
 * And they have to have set up their second factor. These are route handlers,
 * so no layout runs in front of them: the `requireStaff()` gate that sends an
 * unenrolled employee to /admin/two-factor/setup on every /admin page never
 * sees these URLs, and the admin UI links straight to them. Without the check
 * here an employee who had merely accepted an invitation and set a password
 * could read every customer's invoice, Rechnungskorrektur and offer through
 * the /client/… routes while /admin/** was still refusing them.
 */
export async function documentViewer(needed: Permission) {
    const staff = await getStaffSession();

    if (staff) {
        if (!staff.user.twoFactorEnabled) {
            redirect("/admin/two-factor/setup");
        }

        if (!(await staffCan(db, staff.user.id, needed))) {
            notFound();
        }

        return { customerId: ANY_CUSTOMER, isAdmin: true as const };
    }

    const { customer } = await getCurrentCustomer();

    return { customerId: customer.id, isAdmin: false as const };
}
