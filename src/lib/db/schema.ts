import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
    bigint,
    boolean,
    index,
    integer,
    jsonb,
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
 *
 * Every row here is a customer. Employees are a second Better Auth instance
 * on the staff_* tables further down, with their own credentials — which is
 * what lets one address be both a customer and an employee without either
 * side knowing about the other.
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

    // Better Auth two-factor plugin.
    twoFactorEnabled: boolean("two_factor_enabled").default(false),

    /** Provider-side identity, created the first time a method is stored. */
    stripeCustomerId: text("stripe_customer_id").unique(),
    paypalCustomerId: text("paypal_customer_id").unique(),

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
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("staffuser")),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    /** Always true: the invitation is sent to the address and is the only way
     *  in, so confirming it separately would ask the same question twice. */
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const staffSession = pgTable("staff_session", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("staffsession")),
    userId: text("user_id")
        .notNull()
        .references(() => staffUser.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const staffAccount = pgTable("staff_account", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("staffaccount")),
    userId: text("user_id")
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const staffVerification = pgTable("staff_verification", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId("staffverification")),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const staffTwoFactor = pgTable(
    "staff_two_factor",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("stafftwofactor")),
        userId: text("user_id")
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

    /**
     * Set when the customer asked for this contract to be collected
     * automatically. The table is declared further down, hence the lazy
     * reference; set null rather than cascade, because withdrawing a payment
     * method must not take the contract with it.
     */
    paymentMethodId: text("payment_method_id").references(
        (): AnyPgColumn => paymentMethod.id,
        { onDelete: "set null" },
    ),

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

    /**
     * Frozen copies taken at issue time. `recipient` is the address block the
     * PDF prints; the fields below are the same address in the structured
     * shape EN 16931 wants, because the XRechnung is a document too — reading
     * it from the live account would rewrite an invoice the customer holds
     * every time they correct a typo in their own master data.
     */
    recipient: text("recipient"),
    buyerReference: text("buyer_reference"),
    buyerName: text("buyer_name"),
    buyerStreet: text("buyer_street"),
    buyerPostalCode: text("buyer_postal_code"),
    buyerCity: text("buyer_city"),
    buyerCountry: text("buyer_country"),
    buyerVatId: text("buyer_vat_id"),
    buyerEmail: text("buyer_email"),

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

export const paymentProvider = pgEnum("payment_provider", ["stripe", "paypal"]);

/**
 * A payment method the customer left behind so a contract can be collected
 * without them. The token is the provider's: a Stripe PaymentMethod (pm_…) or
 * a PayPal vault token. We never see a card number or an IBAN.
 */
export const paymentMethod = pgTable(
    "payment_method",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("paymentmethod")),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "restrict" }),
        provider: paymentProvider("provider").notNull(),
        /** Unique so the same authorisation cannot be stored twice. */
        token: text("token").notNull().unique(),
        /** What the customer recognises: "Visa •••• 4242", "PayPal, max@…". */
        label: text("label").notNull(),
        /**
         * Revoked rather than deleted: a payment that was collected through it
         * must keep pointing at something. Stripe's detach is irreversible, so
         * the row is the only record left afterwards.
         */
        revokedAt: timestamp("revoked_at"),
        /**
         * Set when the provider confirmed the token is gone on their side.
         * Revoking always works here; deleting there can fail, and the
         * difference is what the customer was promised, so it is recorded
         * rather than assumed.
         */
        detachedAt: timestamp("detached_at"),

        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => [index("payment_method_user_id_idx").on(table.userId)],
);

export const paymentStatus = pgEnum("payment_status", [
    /** Started, customer is at the provider or the charge is in flight. */
    "pending",
    /** Accepted but not yet money — a SEPA debit takes days to settle. */
    "processing",
    "succeeded",
    "failed",
    "refunded",
]);

/**
 * One attempt to pay one invoice. Attempts are kept, not overwritten: a
 * customer who abandons a checkout and comes back leaves two rows, and the
 * provider's own reference has to stay resolvable for the books.
 */
export const payment = pgTable(
    "payment",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("payment")),
        invoiceId: text("invoice_id")
            .notNull()
            .references(() => invoice.id, { onDelete: "restrict" }),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "restrict" }),
        provider: paymentProvider("provider").notNull(),
        status: paymentStatus("status").notNull().default("pending"),

        /** Set when the charge was collected from a stored method. */
        paymentMethodId: text("payment_method_id").references(
            () => paymentMethod.id,
            { onDelete: "set null" },
        ),

        amountCents: integer("amount_cents").notNull(),
        /** § 19 UStG: no tax anywhere, but the currency still has to match. */
        currency: text("currency").notNull().default("EUR"),

        /** What we sent the customer to: Checkout Session or PayPal order. */
        providerRef: text("provider_ref").notNull().unique(),
        /** What actually moved the money: PaymentIntent or PayPal capture. */
        captureRef: text("capture_ref").unique(),
        /** The provider's cut, in cents, once it is known. */
        feeCents: integer("fee_cents"),

        failureCode: text("failure_code"),
        failureMessage: text("failure_message"),

        settledAt: timestamp("settled_at"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => [index("payment_invoice_id_idx").on(table.invoiceId)],
);

/**
 * The operator's own details — everything the Impressum, the invoices and the
 * legal texts quote. One row, because there is one operator; the defaults in
 * src/lib/site.ts apply until it exists, so a fresh database still serves a
 * complete site.
 */
export const siteSetting = pgTable("site_setting", {
    id: text("id").primaryKey(),

    siteName: text("site_name").notNull(),
    siteUrl: text("site_url").notNull(),
    tagline: text("tagline").notNull(),
    description: text("description").notNull(),

    operatorName: text("operator_name").notNull(),
    operatorStreet: text("operator_street").notNull(),
    operatorCity: text("operator_city").notNull(),
    operatorCountry: text("operator_country").notNull(),
    operatorEmail: text("operator_email").notNull(),
    operatorVatId: text("operator_vat_id").notNull(),
    operatorPhone: text("operator_phone").notNull(),

    bankName: text("bank_name").notNull(),
    bankIban: text("bank_iban").notNull(),
    bankBic: text("bank_bic").notNull(),

    logRetentionDays: integer("log_retention_days").notNull(),
    paymentTermDays: integer("payment_term_days").notNull(),
    dataRetrievalDays: integer("data_retrieval_days").notNull(),
    securityMaintenanceNoticeHours: integer(
        "security_maintenance_notice_hours",
    ).notNull(),

    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const legalKind = pgEnum("legal_kind", ["terms", "privacy", "imprint"]);

export const legalStatus = pgEnum("legal_status", [
    "draft",
    "published",
    "archived",
]);

/**
 * One version of one legal document. Versions are kept rather than
 * overwritten: § 17 of the terms promises six weeks' notice before a change
 * takes effect, which only means something if the fassung that was in force
 * at any given moment can still be produced.
 */
export const legalDocument = pgTable(
    "legal_document",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("legaldocument")),
        kind: legalKind("kind").notNull(),
        version: integer("version").notNull(),
        status: legalStatus("status").notNull().default("draft"),

        title: text("title").notNull(),
        eyebrow: text("eyebrow"),
        intro: text("intro"),

        /** The day it starts to apply; never in the past when published. */
        effectiveFrom: timestamp("effective_from", { mode: "date" }),
        publishedAt: timestamp("published_at"),
        /** Set when the customers were told, so it is not sent twice. */
        announcedAt: timestamp("announced_at"),

        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => [index("legal_document_kind_idx").on(table.kind)],
);

export const legalSection = pgTable(
    "legal_section",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId("legalsection")),
        documentId: text("document_id")
            .notNull()
            .references(() => legalDocument.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        /** "§ 7", "01" — the two documents number differently. */
        label: text("label"),
        title: text("title").notNull(),
        /** paren | dash | prose, see src/lib/legal/types.ts. */
        variant: text("variant").notNull().default("paren"),
        /** The items, in order; a nested list is encoded in the item itself. */
        items: jsonb("items").notNull(),
    },
    (table) => [index("legal_section_document_id_idx").on(table.documentId)],
);

/**
 * A payment-method setup the customer has started but not yet finished. Both
 * providers send them back to a URL anyone could construct, carrying an
 * identifier anyone could present — so the identifier is only worth anything
 * if we minted it for this account. The row is written before the redirect
 * and consumed on return, once.
 */
export const paymentSetup = pgTable("payment_setup", {
    /** The provider's own id: a Checkout Session or a PayPal setup token. */
    id: text("id").primaryKey(),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    provider: paymentProvider("provider").notNull(),
    /** The contract the setup was started from, if it was started from one. */
    contractId: text("contract_id").references(() => contract.id, {
        onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Every webhook a provider has already delivered. Providers retry, and both
 * of them say so plainly: the same event will arrive twice. The primary key
 * is what makes handling it twice a no-op.
 */
export const webhookEvent = pgTable("webhook_event", {
    id: text("id").primaryKey(),
    provider: paymentProvider("provider").notNull(),
    type: text("type").notNull(),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
});
