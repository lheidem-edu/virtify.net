import { type db as defaultDb, schema } from "@/db";

/**
 * Hard rule 8: every state change leaves a trace of who did what to which row
 * and what it looked like before.
 *
 * `audit()` takes the transaction it should write in, because an entry that
 * survives a rolled-back change would describe something that never happened,
 * and a change that commits without its entry is a gap in the record.
 */

type Db = Pick<typeof defaultDb, "insert">;

export type Actor =
    | { type: "staff"; id: string; label?: string | null }
    | { type: "customer"; id: string; label?: string | null }
    | { type: "api"; id: string; label?: string | null }
    | { type: "system"; id?: null; label?: string | null };

export type AuditEntry = {
    actor: Actor;
    /** `entity.verb`, e.g. `customer.update`. */
    action: string;
    entityType: string;
    entityId: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    ip?: string | null;
    userAgent?: string | null;
};

export async function audit(db: Db, entry: AuditEntry): Promise<void> {
    await db.insert(schema.auditLog).values({
        actorType: entry.actor.type,
        actorId: entry.actor.id ?? null,
        actorLabel: entry.actor.label ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
    });
}

/**
 * Only the fields that actually differ, as the pair the log stores. Writing
 * the whole row would bury the one value that changed and would copy the
 * customer's address into a second place on every save.
 */
export function diff<T extends Record<string, unknown>>(
    before: T,
    after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
    const from: Record<string, unknown> = {};
    const to: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(after)) {
        if (before[key] !== value) {
            from[key] = before[key] ?? null;
            to[key] = value ?? null;
        }
    }

    return Object.keys(to).length === 0 ? null : { before: from, after: to };
}
