import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";

/**
 * The employees' own Better Auth instance. Separate tables and separate
 * credentials, which is what lets one address be both a customer and an employee
 * without either side knowing about the other.
 */

/**
 * The employees' own Better Auth instance, on its own tables. It exists so an
 * address can be both: kontakt@… as a customer with a Kundennummer and an
 * invoice history, and kontakt@… as an employee with a password of its own,
 * its own two-factor secret and its own session cookie. Neither side can
 * reach the other, and losing one has no effect on the other.
 *
 * The columns mirror what the Drizzle adapter expects, table for table — the
 * only differences from the customer side are the names and what is missing:
 * no master data, no customer number, nothing to invoice.
 */
export const staffUser = pgTable("staff_user", {
    id: ulidPk("staffuser"),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    /** Always true: the invitation is sent to the address and is the only way
     *  in, so confirming it separately would ask the same question twice. */
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    ...timestamps(),
});

export const staffSession = pgTable("staff_session", {
    id: ulidPk("staffsession"),
    userId: ulidFk("user_id")
        .notNull()
        .references(() => staffUser.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps(),
});

export const staffAccount = pgTable("staff_account", {
    id: ulidPk("staffaccount"),
    userId: ulidFk("user_id")
        .notNull()
        .references(() => staffUser.id, { onDelete: "cascade" }),
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

export const staffVerification = pgTable("staff_verification", {
    id: ulidPk("staffverification"),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    ...timestamps(),
});

export const staffTwoFactor = pgTable(
    "staff_two_factor",
    {
        id: ulidPk("stafftwofactor"),
        userId: ulidFk("user_id")
            .notNull()
            .references(() => staffUser.id, { onDelete: "cascade" }),
        secret: text("secret").notNull(),
        backupCodes: text("backup_codes").notNull(),
        verified: boolean("verified").default(true),
        failedVerificationCount: integer("failed_verification_count").default(
            0,
        ),
        lockedUntil: timestamp("locked_until"),
    },
    (table) => [
        index("staff_two_factor_user_id_idx").on(table.userId),
        index("staff_two_factor_secret_idx").on(table.secret),
    ],
);

/** Separate counters, so a customer's failed sign-ins cannot lock out the
 *  admin area or the other way round. */
export const staffRateLimit = pgTable("staff_rate_limit", {
    id: text("id").primaryKey(),
    key: text("key"),
    count: integer("count"),
    lastRequest: bigint("last_request", { mode: "number" }),
});

/**
 * RBAC. A role is a named bundle of permission strings; an employee holds any
 * number of roles and may do anything any of them grants.
 *
 * The strings themselves are not a table: the catalogue of what exists lives
 * in src/server/auth/permissions.ts, so a typo is a type error rather than a
 * row nobody notices. What the database holds is which of them were granted.
 */
export const staffRole = pgTable("staff_role", {
    id: ulidPk("staffrole"),
    name: text("name").notNull().unique(),
    description: text("description"),
    /** Permission strings. `*` grants everything, `billing.*` a domain. */
    permissions: text("permissions")
        .array()
        .notNull()
        .default(sql`'{}'::text[]`),
    /**
     * Seeded roles. "Super Admin" is one: it cannot be deleted or have its
     * permissions taken away, because an account that can edit roles could
     * otherwise lock every employee out of the panel for good.
     */
    isSystem: boolean("is_system").notNull().default(false),
    ...timestamps(),
});

export const staffRoleAssignment = pgTable(
    "staff_role_assignment",
    {
        id: ulidPk("staffroleassignment"),
        staffUserId: ulidFk("staff_user_id")
            .notNull()
            .references(() => staffUser.id, { onDelete: "cascade" }),
        roleId: ulidFk("role_id")
            .notNull()
            .references(() => staffRole.id, { onDelete: "cascade" }),
        ...timestamps(),
    },
    (table) => [
        uniqueIndex("staff_role_assignment_user_role_idx").on(
            table.staffUserId,
            table.roleId,
        ),
    ],
);

export type StaffRole = typeof staffRole.$inferSelect;
