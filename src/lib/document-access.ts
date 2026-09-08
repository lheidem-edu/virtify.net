import "server-only";
import { requireSession } from "@/lib/auth-session";
import { ANY_CUSTOMER } from "@/lib/documents/repository";
import { getStaffSession } from "@/lib/staff-session";

/**
 * Who is asking for a document. The PDF and XML routes are the one place both
 * sides meet: a customer opens their own invoice from the Kundenbereich, and
 * an employee opens the same document from Verwaltung. There is one URL for
 * it, so the route asks here which of the two is holding it.
 *
 * The staff session wins when both cookies are present — that is a person
 * looking at the document as an employee, and the customer view is the one
 * they can reach without it.
 */
export async function documentViewer() {
    const staff = await getStaffSession();

    if (staff) {
        return { userId: ANY_CUSTOMER, isAdmin: true as const };
    }

    const session = await requireSession();

    return { userId: session.user.id, isAdmin: false as const };
}
