import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { money, timestamps, ulidFk, ulidPk } from "./_columns";
import { user } from "./auth";
import { paymentMethod } from "./payments";

/**
 * The recurring agreement behind a service. The subscription engine of Phase 6
 * will grow out of this.
 */

export const contractStatus = pgEnum("contract_status", [
    "provisioning",
    "active",
    "terminated",
    "ended",
]);

export const contract = pgTable("contract", {
    id: ulidPk("contract"),
    userId: ulidFk("user_id")
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
    monthlyPriceCents: money("monthly_price_cents").notNull(),
    terminatedTo: timestamp("terminated_to", { mode: "date" }),

    /**
     * Set when the customer asked for this contract to be collected
     * automatically. The table is declared further down, hence the lazy
     * reference; set null rather than cascade, because withdrawing a payment
     * method must not take the contract with it.
     */
    paymentMethodId: ulidFk("payment_method_id").references(
        (): AnyPgColumn => paymentMethod.id,
        { onDelete: "set null" },
    ),

    /** Internal only — never rendered in the customer area. */
    note: text("note"),

    ...timestamps(),
});

export type Contract = typeof contract.$inferSelect;
