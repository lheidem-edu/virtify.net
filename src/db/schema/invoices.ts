import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
    index,
    integer,
    pgEnum,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { money, timestamps, ulidFk, ulidPk } from "./_columns";
import { user } from "./auth";
import { contract } from "./contracts";

/**
 * Rechnungen and their Korrekturen, plus the gapless counters that number them.
 */

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
    id: ulidPk("invoice"),
    userId: ulidFk("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "restrict" }),
    contractId: ulidFk("contract_id").references(() => contract.id, {
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
    cancelsInvoiceId: ulidFk("cancels_invoice_id").references(
        (): AnyPgColumn => invoice.id,
        { onDelete: "restrict" },
    ),

    introText: text("intro_text"),
    note: text("note"),
    ...timestamps(),
});

export const invoiceItem = pgTable(
    "invoice_item",
    {
        id: ulidPk("invoiceitem"),
        invoiceId: ulidFk("invoice_id")
            .notNull()
            .references(() => invoice.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        description: text("description").notNull(),
        quantity: integer("quantity").notNull().default(1),
        unitCode: text("unit_code").notNull().default("MON"),
        unitPriceCents: money("unit_price_cents").notNull(),
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

export type Invoice = typeof invoice.$inferSelect;
export type InvoiceItem = typeof invoiceItem.$inferSelect;
