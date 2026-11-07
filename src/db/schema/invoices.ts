import {
    index,
    integer,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { money, timestamps, ulidFk, ulidPk } from "./_columns";
import { contract } from "./contracts";
import { customer } from "./customers";

/**
 * Rechnungen, Rechnungskorrekturen and the gapless counters that number them.
 *
 * An invoice is mutable exactly once: while it is a draft. Finalizing assigns
 * the sequential number § 14 Abs. 4 Nr. 4 UStG requires, freezes the seller,
 * the buyer, the tax strategy and the totals onto the row, and from then on
 * the document is read-only — enforced in the service layer *and* by a
 * Postgres trigger, because the database is the only place a stray UPDATE
 * from a migration, a console or a future bug has to pass through.
 *
 * Corrections are never edits: a Rechnungskorrektur is a document of its own,
 * on its own number range, pointing at the invoice it credits.
 */

export const invoiceStatus = pgEnum("invoice_status", [
    /** No number, no legal existence; freely editable and deletable. */
    "draft",
    /** Finalized and payable. */
    "unpaid",
    /**
     * Some money has arrived and some is still owed. Still an *open* invoice
     * in every sense that matters — it is dunned, it is listed under "offen",
     * and it can still be paid — so every check that means "open" asks
     * `OPEN_INVOICE_STATUSES` rather than comparing against `unpaid`.
     */
    "partial",
    "paid",
    /** Fully credited by a Rechnungskorrektur. */
    "cancelled",
]);

export type InvoiceStatus = (typeof invoiceStatus.enumValues)[number];

/**
 * An invoice that has been issued and still wants money. The constant exists
 * so that adding `partial` to the enum could not leave a half-paid invoice
 * invisible on a list that happened to compare against `"unpaid"`.
 */
export const OPEN_INVOICE_STATUSES = ["unpaid", "partial"] as const;

export function isOpenInvoice(status: InvoiceStatus): boolean {
    return (OPEN_INVOICE_STATUSES as readonly string[]).includes(status);
}

/** Shared by invoices and credit notes: what the document says about tax. */
const taxSnapshot = () => ({
    /**
     * The strategy id that was in force when the document was finalized, as
     * resolved from `tax_mode_history` by the finalization date. Frozen here
     * so the document can be re-rendered under a build that has since
     * switched to another one.
     */
    taxStrategy: text("tax_strategy"),
    /** The strategy's notes, already joined — § 14 Abs. 4 Nr. 8 UStG. */
    taxNote: text("tax_note"),
});

/** The seller, as § 14 Abs. 4 Nr. 1–2 UStG wants them on the document. */
const sellerSnapshot = () => ({
    sellerName: text("seller_name"),
    sellerStreet: text("seller_street"),
    sellerCity: text("seller_city"),
    sellerCountry: text("seller_country"),
    sellerEmail: text("seller_email"),
    sellerPhone: text("seller_phone"),
    /** USt-IdNr., if the operator holds one. */
    sellerVatId: text("seller_vat_id"),
    /** Steuernummer — a Kleinunternehmer usually prints this one. */
    sellerTaxNumber: text("seller_tax_number"),
    sellerBankName: text("seller_bank_name"),
    sellerIban: text("seller_iban"),
    sellerBic: text("seller_bic"),
});

/** The buyer, frozen so a later change of address cannot rewrite a document. */
const buyerSnapshot = () => ({
    /** The address block as it is printed, one element per line. */
    recipient: text("recipient"),
    buyerReference: text("buyer_reference"),
    buyerName: text("buyer_name"),
    buyerStreet: text("buyer_street"),
    buyerPostalCode: text("buyer_postal_code"),
    buyerCity: text("buyer_city"),
    buyerCountry: text("buyer_country"),
    buyerVatId: text("buyer_vat_id"),
    buyerEmail: text("buyer_email"),
    buyerCustomerNumber: integer("buyer_customer_number"),
});

/** Where the rendered PDF lives, and what it was when it was written. */
const pdfSnapshot = () => ({
    /** Key in the document store — see `src/server/storage`. */
    pdfKey: text("pdf_key"),
    /** Hex SHA-256 of the stored bytes, so a swap is detectable. */
    pdfSha256: text("pdf_sha256"),
    pdfBytes: integer("pdf_bytes"),
    pdfRenderedAt: timestamp("pdf_rendered_at"),
});

export const invoice = pgTable(
    "invoice",
    {
        id: ulidPk("invoice"),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
        contractId: ulidFk("contract_id").references(() => contract.id, {
            onDelete: "set null",
        }),

        /** Null until finalized; unique so a number is never handed out twice. */
        number: text("number").unique(),
        status: invoiceStatus("status").notNull().default("draft"),

        /** ISO 4217. Every amount on the document is in it. */
        currency: text("currency").notNull().default("EUR"),

        ...buyerSnapshot(),
        ...sellerSnapshot(),
        ...taxSnapshot(),
        ...pdfSnapshot(),

        /**
         * The totals as they were computed at finalization. Redundant with
         * the lines on purpose: a stored total is what the list, the revenue
         * monitor and the payment reconciliation read, and a test asserts it
         * still equals what the lines add up to.
         */
        netCents: money("net_cents"),
        taxCents: money("tax_cents"),
        grossCents: money("gross_cents"),
        /** What Rechnungskorrekturen have taken back off this invoice. */
        creditedCents: money("credited_cents").notNull().default(0),
        /**
         * What has actually been received against it: successful charges
         * less refunds, maintained by `applyPayment` inside the transaction
         * that settles each one. Never larger than the lines say, because an
         * overpayment goes to `credit_ledger` instead of inflating this.
         *
         * One of the few columns migration 0020 lets past the immutability
         * trigger, for the reason rule 3 already allows `paid_at` through: it
         * is a fact *about* the invoice, not a statement *on* it. Nothing
         * printed on the document moves.
         */
        paidCents: money("paid_cents").notNull().default(0),

        /**
         * Rechnungsdatum, and the instant the tax strategy was resolved at.
         * Set once, at finalization; null while the invoice is a draft.
         */
        issuedAt: timestamp("issued_at"),
        /** § 10 of the terms: due within 14 days unless agreed otherwise. */
        dueAt: timestamp("due_at"),
        /** Document-wide Leistungszeitraum; a line may narrow it. */
        servicePeriodStart: timestamp("service_period_start"),
        servicePeriodEnd: timestamp("service_period_end"),
        paidAt: timestamp("paid_at"),
        cancelledAt: timestamp("cancelled_at"),
        /** Last time the document was mailed out. */
        sentAt: timestamp("sent_at"),

        introText: text("intro_text"),
        note: text("note"),
        ...timestamps(),
    },
    (table) => [
        index("invoice_customer_id_idx").on(table.customerId),
        index("invoice_status_idx").on(table.status),
        index("invoice_issued_at_idx").on(table.issuedAt),
    ],
);

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

        /** Leistungszeitraum of this line, where it differs from the document's. */
        servicePeriodStart: timestamp("service_period_start"),
        servicePeriodEnd: timestamp("service_period_end"),

        /**
         * The tax decision, snapshotted at finalization — never a live
         * lookup. `tax_rate_bp` is basis points (1900 = 19 %) so a rate is an
         * integer and cannot pick up a float's rounding error, and `tax_rule`
         * names *why* the rate is what it is, which is the part that makes an
         * old invoice explainable after the rules have moved on.
         */
        taxStrategy: text("tax_strategy"),
        taxRateBp: integer("tax_rate_bp"),
        /** UNTDID 5305 — `S`, `E`, `AE`, `O`, … */
        taxCategory: text("tax_category"),
        taxRule: text("tax_rule"),
        /** quantity × unit price, rounded once, at finalization. */
        netCents: money("net_cents"),
    },
    (table) => [
        index("invoice_item_invoice_id_idx").on(table.invoiceId),
        uniqueIndex("invoice_item_position_idx").on(
            table.invoiceId,
            table.position,
        ),
    ],
);

/**
 * A Rechnungskorrektur: its own document, its own gapless number range, and a
 * hard reference to the invoice it credits.
 *
 * Amounts are stored positive, the way UNTDID 1001 type 381 expects a credit
 * note to be expressed — the document's heading says it is a correction, so
 * the figures do not also have to carry a minus. Everything that aggregates
 * money subtracts them explicitly, which is visible at the call site instead
 * of hidden in a sign.
 *
 * There is no draft: a correction is created and finalized in one
 * transaction, because a half-made correction of a document the customer
 * already holds has no meaning.
 */
export const creditNote = pgTable(
    "credit_note",
    {
        id: ulidPk("creditnote"),
        invoiceId: ulidFk("invoice_id")
            .notNull()
            // Restricted, not cascading: the corrected original must outlive
            // the correction, or the correction documents nothing.
            .references(() => invoice.id, { onDelete: "restrict" }),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),

        number: text("number").notNull().unique(),
        /** `full` reverses the invoice entirely, `partial` a part of it. */
        kind: text("kind").notNull(),
        /** Why it was issued. Printed on the document. */
        reason: text("reason"),

        currency: text("currency").notNull().default("EUR"),

        ...buyerSnapshot(),
        ...sellerSnapshot(),
        ...taxSnapshot(),
        ...pdfSnapshot(),

        netCents: money("net_cents").notNull(),
        taxCents: money("tax_cents").notNull(),
        grossCents: money("gross_cents").notNull(),

        issuedAt: timestamp("issued_at").notNull(),
        servicePeriodStart: timestamp("service_period_start"),
        servicePeriodEnd: timestamp("service_period_end"),
        sentAt: timestamp("sent_at"),

        note: text("note"),
        ...timestamps(),
    },
    (table) => [
        index("credit_note_invoice_id_idx").on(table.invoiceId),
        index("credit_note_customer_id_idx").on(table.customerId),
        index("credit_note_issued_at_idx").on(table.issuedAt),
    ],
);

export const creditNoteItem = pgTable(
    "credit_note_item",
    {
        id: ulidPk("creditnoteitem"),
        creditNoteId: ulidFk("credit_note_id")
            .notNull()
            .references(() => creditNote.id, { onDelete: "cascade" }),
        /** The line being credited, where there is one. */
        invoiceItemId: ulidFk("invoice_item_id").references(
            () => invoiceItem.id,
            { onDelete: "set null" },
        ),
        position: integer("position").notNull(),
        description: text("description").notNull(),
        quantity: integer("quantity").notNull().default(1),
        unitCode: text("unit_code").notNull().default("MON"),
        unitPriceCents: money("unit_price_cents").notNull(),
        detail: text("detail"),

        servicePeriodStart: timestamp("service_period_start"),
        servicePeriodEnd: timestamp("service_period_end"),

        /** Copied verbatim from the invoice line, never re-determined. */
        taxStrategy: text("tax_strategy").notNull(),
        taxRateBp: integer("tax_rate_bp").notNull(),
        taxCategory: text("tax_category").notNull(),
        taxRule: text("tax_rule").notNull(),
        netCents: money("net_cents").notNull(),
    },
    (table) => [
        index("credit_note_item_credit_note_id_idx").on(table.creditNoteId),
        uniqueIndex("credit_note_item_position_idx").on(
            table.creditNoteId,
            table.position,
        ),
    ],
);

/**
 * One row per number range and year. Incremented inside the same transaction
 * that finalizes a document, under the row lock the upsert takes, so two
 * concurrent finalizations serialise instead of colliding.
 */
export const documentCounter = pgTable("document_counter", {
    scope: text("scope").primaryKey(),
    value: integer("value").notNull().default(0),
});

export type Invoice = typeof invoice.$inferSelect;
export type InvoiceItem = typeof invoiceItem.$inferSelect;
export type CreditNote = typeof creditNote.$inferSelect;
export type CreditNoteItem = typeof creditNoteItem.$inferSelect;
