import {
    bigint,
    boolean,
    index,
    integer,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";

/**
 * Better Auth's own tables for customers. Column names follow what the Drizzle
 * adapter expects.
 *
 * A row here is a *login*, nothing more: a name, an address to sign in with
 * and a password. Who it may bill for is `customer_contact` in ./customers.ts,
 * and the master data — company, address, VAT ID, customer number, the
 * gateway identities — sits on `customer`. Before Phase 1 all of it was on
 * this table, which meant a company could have exactly one person able to see
 * its invoices.
 *
 * Employees are a second Better Auth instance entirely — see ./staff.ts.
 */

export const user = pgTable("user", {
    id: ulidPk("user"),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),

    // Better Auth two-factor plugin.
    twoFactorEnabled: boolean("two_factor_enabled").default(false),

    ...timestamps(),
});

export const session = pgTable("session", {
    id: ulidPk("session"),
    userId: ulidFk("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    ...timestamps(),
});

export const account = pgTable("account", {
    id: ulidPk("account"),
    userId: ulidFk("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    ...timestamps(),
});

export const verification = pgTable("verification", {
    id: ulidPk("verification"),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    ...timestamps(),
});

export const twoFactor = pgTable(
    "two_factor",
    {
        id: ulidPk("twofactor"),
        userId: ulidFk("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        secret: text("secret").notNull(),
        backupCodes: text("backup_codes").notNull(),
        /** False between enabling and the first successful code. */
        verified: boolean("verified").default(true),
        /** Drives the plugin's lockout after repeated wrong codes. */
        failedVerificationCount: integer("failed_verification_count").default(
            0,
        ),
        lockedUntil: timestamp("locked_until"),
    },
    (table) => [
        index("two_factor_user_id_idx").on(table.userId),
        index("two_factor_secret_idx").on(table.secret),
    ],
);

/**
 * Better Auth's database-backed rate limiting. Keeping the counters here
 * rather than in memory means they hold across restarts and across more than
 * one instance — in memory, a redeploy would reset every lockout.
 */
export const rateLimit = pgTable("rate_limit", {
    id: text("id").primaryKey(),
    key: text("key"),
    count: integer("count"),
    lastRequest: bigint("last_request", { mode: "number" }),
});

export type User = typeof user.$inferSelect;
