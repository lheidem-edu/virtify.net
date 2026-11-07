import { index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { money, timestamps, ulidFk, ulidPk } from "./_columns";
import { contract } from "./contracts";
import { customer } from "./customers";
import { invoice } from "./invoices";

/**
 * Money coming in: stored payment methods, the attempts made against them, and
 * the provider events that settle them.
 */

export const paymentProvider = pgEnum("payment_provider", ["stripe", "paypal"]);

/**
 * A payment method the customer left behind so a contract can be collected
 * without them. The token is the provider's: a Stripe PaymentMethod (pm_…) or
 * a PayPal vault token. We never see a card number or an IBAN.
 */
export const paymentMethod = pgTable(
    "payment_method",
    {
        id: ulidPk("paymentmethod"),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
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

        ...timestamps(),
    },
    (table) => [index("payment_method_customer_id_idx").on(table.customerId)],
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
        id: ulidPk("payment"),
        invoiceId: ulidFk("invoice_id")
            .notNull()
            .references(() => invoice.id, { onDelete: "restrict" }),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
        provider: paymentProvider("provider").notNull(),
        status: paymentStatus("status").notNull().default("pending"),

        /** Set when the charge was collected from a stored method. */
        paymentMethodId: ulidFk("payment_method_id").references(
            () => paymentMethod.id,
            { onDelete: "set null" },
        ),

        amountCents: money("amount_cents").notNull(),
        /** § 19 UStG: no tax anywhere, but the currency still has to match. */
        currency: text("currency").notNull().default("EUR"),

        /** What we sent the customer to: Checkout Session or PayPal order. */
        providerRef: text("provider_ref").notNull().unique(),
        /** What actually moved the money: PaymentIntent or PayPal capture. */
        captureRef: text("capture_ref").unique(),
        /** The provider's cut, in cents, once it is known. */
        feeCents: money("fee_cents"),

        failureCode: text("failure_code"),
        failureMessage: text("failure_message"),

        settledAt: timestamp("settled_at"),
        ...timestamps(),
    },
    (table) => [index("payment_invoice_id_idx").on(table.invoiceId)],
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
    customerId: ulidFk("customer_id")
        .notNull()
        .references(() => customer.id, { onDelete: "cascade" }),
    provider: paymentProvider("provider").notNull(),
    /** The contract the setup was started from, if it was started from one. */
    contractId: ulidFk("contract_id").references(() => contract.id, {
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
