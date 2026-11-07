import {
    boolean,
    index,
    integer,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";
import { user } from "./auth";

/**
 * The billing account and the logins that may act for it.
 *
 * Until Phase 1 these were the same row: one `user` carried the login *and*
 * the master data, so a company could only ever have one person who could see
 * its invoices. They are two tables now, which is what makes a shared account
 * possible — and what every document, payment and subscription points at from
 * here on is the customer, never the login.
 */

export const customerKind = pgEnum("customer_kind", ["company", "private"]);

export const customerStatus = pgEnum("customer_status", [
    "active",
    /** Still billed, but services are stopped — dunning sets this in Phase 6. */
    "suspended",
    /** Nothing runs any more; kept because invoices point at it. */
    "closed",
]);

export const customer = pgTable(
    "customer",
    {
        id: ulidPk("customer"),

        /** Short, human-facing number for documents and support. */
        customerNumber: integer("customer_number").notNull().unique(),

        /**
         * Whether this is a Firma or a Privatperson. It decides which
         * consumer protections apply — the Widerrufsrecht is a private
         * customer's — and, once regular VAT is switched on, whether a
         * VAT ID can make the sale B2B.
         */
        kind: customerKind("kind").notNull().default("private"),

        /** The invoice recipient: the company for a Firma, the person otherwise. */
        name: text("name").notNull(),
        company: text("company"),
        street: text("street"),
        postalCode: text("postal_code"),
        city: text("city"),
        /** ISO 3166-1 alpha-2. Drives the tax determination from Phase 3. */
        country: text("country"),
        vatId: text("vat_id"),
        /**
         * When the VAT ID last came back valid from VIES. A number that has
         * never been checked must not produce a reverse-charge invoice, so
         * the date is part of the decision rather than a note.
         */
        vatIdValidatedAt: timestamp("vat_id_validated_at"),
        phone: text("phone"),
        /** EN 16931 BT-10. Public buyers supply a Leitweg-ID; otherwise the
         *  customer number is used so the mandatory field is always populated. */
        buyerReference: text("buyer_reference"),

        /** ISO 4217. Every amount on this account is in it. */
        currency: text("currency").notNull().default("EUR"),
        /** Language for documents and mail — `de` or `en`. */
        language: text("language").notNull().default("de"),
        status: customerStatus("status").notNull().default("active"),

        /** Internal only — never rendered in the customer area. */
        notes: text("notes"),

        /** Provider-side identity, created the first time a method is stored. */
        stripeCustomerId: text("stripe_customer_id").unique(),
        paypalCustomerId: text("paypal_customer_id").unique(),

        /** Rule 10: never hard-delete anything an invoice points at. */
        deletedAt: timestamp("deleted_at"),

        ...timestamps(),
    },
    (table) => [
        index("customer_status_idx").on(table.status),
        index("customer_email_search_idx").on(table.name),
    ],
);

export const customerContactRole = pgEnum("customer_contact_role", [
    /** Created the account, cannot be removed by another contact. */
    "owner",
    "contact",
]);

/**
 * A login's membership of a billing account, with what it is allowed to do
 * there. One `user` can hold several of these — a Steuerberater on two
 * companies' accounts — which is why scoping goes through
 * `getCurrentCustomer()` and never through the session's user id.
 */
export const customerContact = pgTable(
    "customer_contact",
    {
        id: ulidPk("customercontact"),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "cascade" }),
        userId: ulidFk("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        role: customerContactRole("role").notNull().default("contact"),

        /**
         * The address this contact is reached at. It starts as the login
         * address but is kept separately, because Phase 7 matches incoming
         * mail against it and a login address may change.
         */
        email: text("email").notNull(),

        /** Sub-permissions. The owner has all three and cannot lose them. */
        canBilling: boolean("can_billing").notNull().default(true),
        canTechnical: boolean("can_technical").notNull().default(true),
        canTickets: boolean("can_tickets").notNull().default(true),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("customer_contact_customer_user_idx").on(
            table.customerId,
            table.userId,
        ),
        index("customer_contact_user_id_idx").on(table.userId),
        index("customer_contact_email_idx").on(table.email),
    ],
);

export type Customer = typeof customer.$inferSelect;
export type CustomerContact = typeof customerContact.$inferSelect;
