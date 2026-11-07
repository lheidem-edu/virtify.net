import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { requireSession } from "@/server/auth/session";
import { customerForUser } from "@/server/customers/repository";

/**
 * The one way client-area code learns which rows it may touch.
 *
 * Hard rule 5: the session says who is signed in, never what they may read.
 * Every query in `(client)` scopes by the id this returns, and nothing in
 * there takes a customer id from the request — which is why a page cannot be
 * tricked into reading somebody else's invoices by changing a parameter.
 *
 * `cache` makes it one query per request however many loaders ask.
 */
export const getCurrentCustomer = cache(async () => {
    const session = await requireSession();
    const row = await customerForUser(db, session.user.id);

    if (!row) {
        // A login with no billing account can do nothing in the portal. It
        // should not exist — sign-up creates both — so this is a broken
        // account rather than a state to render a page for.
        redirect("/client/no-account");
    }

    return {
        customer: row.customer,
        contact: row.contact,
        user: session.user,
    };
});

/** Just the id, for the many loaders that want nothing else. */
export async function currentCustomerId(): Promise<string> {
    return (await getCurrentCustomer()).customer.id;
}
