import {
    index,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { ulidPk } from "./_columns";

/**
 * Hard rule 8: every state change on customers, subscriptions, services,
 * invoices, payments, tickets and settings leaves a row here.
 *
 * The table is append-only by intent — nothing in the application updates or
 * deletes a row — and it deliberately carries no foreign keys: an entry has
 * to survive the thing it describes being removed, which is exactly the case
 * where it matters most.
 */

export const auditActorType = pgEnum("audit_actor_type", [
    "staff",
    "customer",
    /** An API key acted. `actorId` is the key, `onBehalfOf` its owner. */
    "api",
    /** A job, a webhook, a migration — nobody was at the keyboard. */
    "system",
]);

export const auditLog = pgTable(
    "audit_log",
    {
        id: ulidPk("auditlog"),

        actorType: auditActorType("actor_type").notNull(),
        /** The staff user, the customer contact's login, or the API key. */
        actorId: text("actor_id"),
        /** What to print when the actor is gone: a name or an address. */
        actorLabel: text("actor_label"),

        /** `customer.update`, `invoice.finalize`, `api_key.revoke`. */
        action: text("action").notNull(),
        entityType: text("entity_type").notNull(),
        entityId: text("entity_id").notNull(),

        /**
         * Only the fields that actually changed, as `{ field: value }`. The
         * whole row would bury the change and would copy data that is not
         * ours to keep a second time.
         */
        before: jsonb("before"),
        after: jsonb("after"),

        ip: text("ip"),
        userAgent: text("user_agent"),

        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => [
        index("audit_log_entity_idx").on(table.entityType, table.entityId),
        index("audit_log_actor_idx").on(table.actorType, table.actorId),
    ],
);

export type AuditLog = typeof auditLog.$inferSelect;
