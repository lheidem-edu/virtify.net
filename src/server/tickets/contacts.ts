import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";

/**
 * The address a ticket opened for an account is attributed to.
 *
 * The owner contact's, or the oldest contact's — never one the request
 * supplied, for a customer key. A key that could name the requester could
 * open a ticket in somebody else's name, and every reply to it would go to
 * the address the ticket learned here.
 */
export async function contactEmailFor(
    db: Pick<typeof defaultDb, "select">,
    customerId: string,
): Promise<string | null> {
    const [owner] = await db
        .select({ email: schema.customerContact.email })
        .from(schema.customerContact)
        .where(
            and(
                eq(schema.customerContact.customerId, customerId),
                eq(schema.customerContact.role, "owner"),
            ),
        )
        .limit(1);

    if (owner) {
        return owner.email;
    }

    const [any] = await db
        .select({ email: schema.customerContact.email })
        .from(schema.customerContact)
        .where(eq(schema.customerContact.customerId, customerId))
        .orderBy(asc(schema.customerContact.id))
        .limit(1);

    return any?.email ?? null;
}
