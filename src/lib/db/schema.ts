import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
    /** EN 16931 BT-10. Public buyers supply a Leitweg-ID; otherwise the
     *  customer number is used so the mandatory field is always populated. */
    buyerReference: text("buyer_reference"),
    /** Short, human-facing number for documents and support. Assigned on
     *  sign-up; the ULID stays the technical key. */
    customerNumber: integer("customer_number").unique(),

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

export const offerStatus = pgEnum("offer_status", [
    "draft",
    "sent",
    "accepted",
    "declined",
    "expired",
    /** Pulled back by the provider — distinct from an offer the customer let lapse. */
    "withdrawn",
]);

/**
 * An offer becomes a contract when the customer accepts it — that acceptance
 * is the Vertragsschluss under § 3 of the terms, so the accepted state and
 * its timestamp are the record of it and must not be edited afterwards.
 */
export const offer = pgTable("offer", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("offer")),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "restrict" }),
    number: text("number").notNull().unique(),
    title: text("title").notNull(),
    status: offerStatus("status").notNull().default("draft"),

    /** Frozen copy of the recipient at send time — a later address change
     *  must not rewrite a document the customer already received. */
    recipient: text("recipient"),

    introText: text("intro_text"),
    /** Terms proposed for the contract that acceptance would create. */
    minimumTermMonths: integer("minimum_term_months").notNull().default(12),
    monthlyPriceCents: integer("monthly_price_cents").notNull().default(0),

    validUntil: timestamp("valid_until", { mode: "date" }),
    sentAt: timestamp("sent_at"),
    decidedAt: timestamp("decided_at"),
    /** Set when acceptance produced a contract. */
    contractId: text("contract_id").references(() => contract.id, {
        onDelete: "set null",
    }),

    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const offerItem = pgTable(
    "offer_item",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("offeritem")),
        offerId: text("offer_id")
            .notNull()
            .references(() => offer.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        description: text("description").notNull(),
        quantity: integer("quantity").notNull().default(1),
        /** UN/ECE Recommendation 20 code, e.g. C62 (piece), MON (month). */
        unitCode: text("unit_code").notNull().default("MON"),
        unitPriceCents: integer("unit_price_cents").notNull(),
        /** Small print under the line: contract reference, billing note. */
        detail: text("detail"),
    },
    (table) => [index("offer_item_offer_id_idx").on(table.offerId)],
);

export const invoiceStatus = pgEnum("invoice_status", [
    "draft",
    "issued",
    "paid",
    "cancelled",
]);

/**
 * Invoices are mutable only while `draft`. Issuing assigns the sequential
 * number required by § 14 Abs. 4 Nr. 4 UStG and freezes the document;
 * corrections are made by cancelling and issuing anew, never by editing.
 */
export const invoice = pgTable("invoice", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("invoice")),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "restrict" }),
    contractId: text("contract_id").references(() => contract.id, {
        onDelete: "set null",
    }),

    /** Null until issued; unique so a number can never be handed out twice. */
    number: text("number").unique(),
    status: invoiceStatus("status").notNull().default("draft"),

    /** Frozen copies taken at issue time. */
    recipient: text("recipient"),
    buyerReference: text("buyer_reference"),

    issuedAt: timestamp("issued_at", { mode: "date" }),
    /** § 10 of the terms: due within 14 days unless agreed otherwise. */
    dueAt: timestamp("due_at", { mode: "date" }),
    servicePeriodStart: timestamp("service_period_start", { mode: "date" }),
    servicePeriodEnd: timestamp("service_period_end", { mode: "date" }),
    paidAt: timestamp("paid_at"),
    cancelledAt: timestamp("cancelled_at"),
    /**
     * Points at the invoice this one corrects, for the audit trail. Restricted
     * rather than cascading: the corrected original must outlive the
     * Rechnungskorrektur, or the correction would document nothing.
     */
    cancelsInvoiceId: text("cancels_invoice_id").references(
        (): AnyPgColumn => invoice.id,
        { onDelete: "restrict" },
    ),

    introText: text("intro_text"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const invoiceItem = pgTable(
    "invoice_item",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("invoiceitem")),
        invoiceId: text("invoice_id")
            .notNull()
            .references(() => invoice.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        description: text("description").notNull(),
        quantity: integer("quantity").notNull().default(1),
        unitCode: text("unit_code").notNull().default("MON"),
        unitPriceCents: integer("unit_price_cents").notNull(),
        /** Small print under the line: contract reference, billing note. */
        detail: text("detail"),
    },
    (table) => [index("invoice_item_invoice_id_idx").on(table.invoiceId)],
);

/**
 * One row per number range and year. Incremented inside the same transaction
 * that issues an invoice, under a row lock, so two concurrent issues cannot
 * receive the same number.
 */
export const documentCounter = pgTable("document_counter", {
    scope: text("scope").primaryKey(),
    value: integer("value").notNull().default(0),
});

export type Offer = typeof offer.$inferSelect;
export type OfferItem = typeof offerItem.$inferSelect;
export type Invoice = typeof invoice.$inferSelect;
export type InvoiceItem = typeof invoiceItem.$inferSelect;
