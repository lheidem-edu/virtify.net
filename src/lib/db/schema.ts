import {
    bigint,
    boolean,
    index,
    integer,
    pgEnum,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { createId } from "./id";

/**
 * Better Auth owns the first four tables; their column names follow what the
 * Drizzle adapter expects. The customer's own master data lives on `user`
 * because one account is one customer — if several logins per customer are
 * ever needed, this is what moves into its own table.
 */
export const user = pgTable("user", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("user")),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),

    // Master data. Empty until the customer fills it in after registering.
    company: text("company"),
    street: text("street"),
    postalCode: text("postal_code"),
    city: text("city"),
    country: text("country"),
    vatId: text("vat_id"),
    phone: text("phone"),

    // Better Auth admin plugin.
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),

    // Better Auth two-factor plugin.
    twoFactorEnabled: boolean("two_factor_enabled").default(false),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("session")),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("account")),
    userId: text("user_id")
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("verification")),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const twoFactor = pgTable(
    "two_factor",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("twofactor")),
        userId: text("user_id")
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

export const contractStatus = pgEnum("contract_status", [
    "provisioning",
    "active",
    "terminated",
    "ended",
]);

export const contract = pgTable("contract", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("contract")),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "restrict" }),

    /** Human-facing number, shown to the customer and used in correspondence. */
    number: text("number").notNull().unique(),
    title: text("title").notNull(),
    status: contractStatus("status").notNull().default("provisioning"),

    /** Contract clock starts here — minimum term and billing both run from it. */
    serviceReadyAt: timestamp("service_ready_at", { mode: "date" }),
    minimumTermMonths: integer("minimum_term_months").notNull().default(12),
    /** Stored in cents to keep money out of floating point. */
    monthlyPriceCents: integer("monthly_price_cents").notNull(),
    terminatedTo: timestamp("terminated_to", { mode: "date" }),

    /** Internal only — never rendered in the customer area. */
    note: text("note"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type User = typeof user.$inferSelect;
export type Contract = typeof contract.$inferSelect;
