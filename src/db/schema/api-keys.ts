import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";
import { customer } from "./customers";
import { staffUser } from "./staff";

/**
 * Keys for the public REST API. The token is shown once, at creation, and
 * never again: what is stored is its SHA-256 hash (`hashToken()` in
 * src/lib/crypto.ts) plus a short prefix so a key can still be recognised in
 * a list.
 *
 * A key belongs to exactly one owner — a staff user or a customer — and can
 * never read more than that owner can. The scopes narrow it further.
 */
export const apiKey = pgTable(
    "api_key",
    {
        id: ulidPk("apikey"),

        /** What the owner called it: "Monitoring", "Buchhaltung". */
        name: text("name").notNull(),

        /** SHA-256 of the token. Unique, so one token means one key. */
        tokenHash: text("token_hash").notNull().unique(),
        /** The visible part, `vfy_` plus eight characters. Not a secret. */
        prefix: text("prefix").notNull(),

        /** Permission strings this key may use, e.g. `customers.read`. */
        scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),

        /** Exactly one of the two is set — see the check constraint. */
        customerId: ulidFk("customer_id").references(() => customer.id, {
            onDelete: "cascade",
        }),
        staffUserId: ulidFk("staff_user_id").references(() => staffUser.id, {
            onDelete: "cascade",
        }),

        lastUsedAt: timestamp("last_used_at"),
        expiresAt: timestamp("expires_at"),
        /** Revoked, not deleted: the audit trail has to keep pointing at it. */
        revokedAt: timestamp("revoked_at"),

        ...timestamps(),
    },
    (table) => [
        check(
            "api_key_one_owner",
            sql`num_nonnulls(${table.customerId}, ${table.staffUserId}) = 1`,
        ),
        index("api_key_customer_id_idx").on(table.customerId),
        index("api_key_staff_user_id_idx").on(table.staffUserId),
    ],
);

export type ApiKey = typeof apiKey.$inferSelect;
