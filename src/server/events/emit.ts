import { and, eq, isNull, lte, or } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { createId } from "@/lib/ulid";
import {
    type DomainEventOf,
    type EventPayload,
    type EventType,
    parseEventPayload,
} from "./catalog";

/**
 * Writing a fact down, and claiming it to act on.
 *
 * ## `emitEvent` takes a transaction, and only a transaction
 *
 * Not a convenience: the parameter type has no `transaction` method, so the
 * only thing that can be passed is a handle that is already inside one. An
 * event emitted beside the write it describes is a fact that can be rolled
 * back while its notification goes out — the customer is told their invoice
 * was paid and the payment is not there. The audit helper is written the same
 * way and for the same reason (`src/server/audit/index.ts`).
 *
 * ## The conflict is the point
 *
 * `on conflict do nothing` on `(type, dedupe_key)`. Two code paths that both
 * know a thing happened — the webhook and the daily pass, the hook and the
 * operator's button — are *supposed* to both emit, and exactly one row is
 * supposed to come of it. The emitter does not look first: a lookup is a
 * race, and the unique index is the answer (Phase 7's `inbound_mail`, Phase
 * 8's `provisioning_resource`).
 */

type Tx = Pick<typeof defaultDb, "insert" | "select" | "update">;

export type EmitInput<T extends EventType> = {
    type: T;
    /** What this occurrence is. See the key table in `./catalog.ts`. */
    dedupeKey: string;
    entityType: string;
    entityId: string;
    customerId?: string | null;
    payload: EventPayload<T>;
    /** When the fact became true. Defaults to now. */
    occurredAt?: Date;
};

/**
 * Writes one event inside the caller's transaction.
 *
 * Returns the row's id when this call is the one that wrote it, and `null`
 * when the event was already there. A caller that does something off the back
 * of the emit — nothing does today, and nothing should — would use that to
 * tell "I am the first" from "somebody else was".
 */
export async function emitEvent<T extends EventType>(
    tx: Tx,
    input: EmitInput<T>,
): Promise<string | null> {
    // zod on the way in. A payload that does not match its schema is the
    // emitter's bug, and finding it here means the dispatcher never has to
    // render a mail around an `undefined`.
    const payload = parseEventPayload(input.type, input.payload);

    const id = createId("event");

    const written = await tx
        .insert(schema.domainEvent)
        .values({
            id,
            type: input.type,
            dedupeKey: input.dedupeKey,
            entityType: input.entityType,
            entityId: input.entityId,
            customerId: input.customerId ?? null,
            payload,
            occurredAt: input.occurredAt ?? new Date(),
        })
        .onConflictDoNothing({
            target: [schema.domainEvent.type, schema.domainEvent.dedupeKey],
        })
        .returning({ id: schema.domainEvent.id });

    return written[0]?.id ?? null;
}

type Db = Pick<typeof defaultDb, "select" | "update">;

/**
 * The events that are waiting, oldest first.
 *
 * `pending` only. `abandoned` is deliberately not picked up again — an event
 * that failed its whole ladder is waiting for a person, and re-reading it
 * every minute would bury the thing that is actually wrong.
 */
export type PendingEvent = DomainEventOf & {
    attempts: number;
    maxAttempts: number;
};

export async function pendingEvents(
    db: Db,
    options: { now?: Date; limit?: number } = {},
): Promise<PendingEvent[]> {
    const now = options.now ?? new Date();

    const rows = await db
        .select()
        .from(schema.domainEvent)
        .where(
            and(
                eq(schema.domainEvent.status, "pending"),
                or(
                    isNull(schema.domainEvent.runAfter),
                    lte(schema.domainEvent.runAfter, now),
                ),
            ),
        )
        .orderBy(schema.domainEvent.id)
        .limit(options.limit ?? 50);

    return rows.map(
        (row) =>
            ({
                id: row.id,
                type: row.type,
                dedupeKey: row.dedupeKey,
                occurredAt: row.occurredAt,
                customerId: row.customerId,
                entityType: row.entityType,
                entityId: row.entityId,
                payload: row.payload,
                attempts: row.attempts,
                maxAttempts: row.maxAttempts,
            }) as PendingEvent,
    );
}

/**
 * Marks an event dealt with. Only a dispatcher that ran to the end calls it,
 * which is the same rule `inbound_mail.handled_at` is written under: a
 * handler that failed halfway must leave the row claimable, or the failure is
 * silent.
 */
export async function markEventDispatched(
    tx: Pick<typeof defaultDb, "update">,
    id: string,
    at: Date = new Date(),
): Promise<void> {
    await tx
        .update(schema.domainEvent)
        .set({
            status: "dispatched",
            dispatchedAt: at,
            lastError: null,
            updatedAt: at,
        })
        .where(eq(schema.domainEvent.id, id));
}

/**
 * How long to wait after a dispatch that threw. Exponential from a minute,
 * capped at an hour — the same ladder `provisioning_task` uses, and capped for
 * the same reason: past four attempts it is waiting for a person, and a
 * six-hour step would mean the person's fix does not take effect until the
 * evening.
 */
export function dispatchBackoffSeconds(attempts: number): number {
    return Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3_600);
}

/**
 * Records a failed dispatch and sets the next attempt, or gives up.
 *
 * A dispatch that exhausted its attempts becomes `abandoned` rather than
 * being left `pending` for ever: `pending` with nothing left would be a row
 * the sweep reads sixty times an hour and can never act on.
 */
export async function recordEventFailure(
    db: Pick<typeof defaultDb, "update">,
    input: { id: string; attempts: number; maxAttempts: number; error: string },
    at: Date = new Date(),
): Promise<void> {
    const attempts = input.attempts + 1;
    const spent = attempts >= input.maxAttempts;

    await db
        .update(schema.domainEvent)
        .set({
            status: spent ? "abandoned" : "pending",
            attempts,
            runAfter: spent
                ? null
                : new Date(
                      at.getTime() + dispatchBackoffSeconds(attempts) * 1_000,
                  ),
            lastError: input.error.slice(0, 1_000),
            updatedAt: at,
        })
        .where(eq(schema.domainEvent.id, input.id));
}
