import {
    index,
    integer,
    pgEnum,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { money, timestamps, ulidFk, ulidPk } from "./_columns";
import { contract } from "./contracts";
import { customer } from "./customers";

/**
 * Angebote — what a contract is made from before it is signed.
 */

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
    id: ulidPk("offer"),
    customerId: ulidFk("customer_id")
        .notNull()
        .references(() => customer.id, { onDelete: "restrict" }),
    number: text("number").notNull().unique(),
    title: text("title").notNull(),
    status: offerStatus("status").notNull().default("draft"),

    /** Frozen copy of the recipient at send time — a later address change
     *  must not rewrite a document the customer already received. */
    recipient: text("recipient"),

    introText: text("intro_text"),
    /** Terms proposed for the contract that acceptance would create. */
    minimumTermMonths: integer("minimum_term_months").notNull().default(12),
    monthlyPriceCents: money("monthly_price_cents").notNull().default(0),

    validUntil: timestamp("valid_until", { mode: "date" }),
    sentAt: timestamp("sent_at"),
    decidedAt: timestamp("decided_at"),
    /** Set when acceptance produced a contract. */
    contractId: ulidFk("contract_id").references(() => contract.id, {
        onDelete: "set null",
    }),

    note: text("note"),
    ...timestamps(),
});

export const offerItem = pgTable(
    "offer_item",
    {
        id: ulidPk("offeritem"),
        offerId: ulidFk("offer_id")
            .notNull()
            .references(() => offer.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        description: text("description").notNull(),
        quantity: integer("quantity").notNull().default(1),
        /** UN/ECE Recommendation 20 code, e.g. C62 (piece), MON (month). */
        unitCode: text("unit_code").notNull().default("MON"),
        unitPriceCents: money("unit_price_cents").notNull(),
        /** Small print under the line: contract reference, billing note. */
        detail: text("detail"),
    },
    (table) => [index("offer_item_offer_id_idx").on(table.offerId)],
);

export type Offer = typeof offer.$inferSelect;
export type OfferItem = typeof offerItem.$inferSelect;
