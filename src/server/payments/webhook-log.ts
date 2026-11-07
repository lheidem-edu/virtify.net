import "server-only";
import { eq, isNull, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { PaymentProvider } from "@/db/schema";

/**
 * Hard rule 7: a webhook is handled once, however often it is delivered.
 *
 * The naïve version — insert the event id, and stop if it is already there —
 * is wrong in a way that only shows up on a bad day: a handler that fails
 * halfway leaves the row behind, so the provider's *retry* finds the event
 * "already delivered", answers 200, and does nothing. A payment that failed
 * to settle once then never settles at all. Deleting the row on failure
 * papers over it and loses the record of the delivery.
 *
 * So the claim is one statement: insert, or take the row back if nobody has
 * finished it. `handled_at` is set only by a handler that ran to the end.
 *
 * Two deliveries racing can therefore both get the claim and both run. That
 * is deliberate: `applyPayment` is idempotent under a row lock, which is
 * where double settlement is actually prevented. This table keeps the common
 * case off the database; it is not the safety net.
 */

type Db = Pick<typeof defaultDb, "insert" | "update" | "select">;

export async function claimEvent(
    db: Db,
    event: { id: string; provider: PaymentProvider; type: string },
): Promise<boolean> {
    const claimed = await db
        .insert(schema.webhookEvent)
        .values({
            id: event.id,
            provider: event.provider,
            type: event.type,
            attempts: 1,
        })
        .onConflictDoUpdate({
            target: schema.webhookEvent.id,
            set: {
                attempts: sql`${schema.webhookEvent.attempts} + 1`,
                receivedAt: new Date(),
            },
            // Only an event nobody has finished may be claimed again.
            setWhere: isNull(schema.webhookEvent.handledAt),
        })
        .returning({ id: schema.webhookEvent.id });

    return claimed.length > 0;
}

/** Called once the handler has done everything it was going to do. */
export async function markEventHandled(db: Db, id: string): Promise<void> {
    await db
        .update(schema.webhookEvent)
        .set({ handledAt: new Date() })
        .where(eq(schema.webhookEvent.id, id));
}
