import { sql } from "drizzle-orm";
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
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { money, timestamps, ulidFk, ulidPk } from "./_columns";
import { contract } from "./contracts";
import { customer } from "./customers";
import { invoice } from "./invoices";

/**
 * Money coming in and going back out: stored payment methods, the attempts
 * made against them, the credit a customer is holding, and the provider
 * events that settle all of it.
 *
 * The one sentence the rest of this file follows from: **our billing engine
 * says what is owed, a gateway only moves money.** Nothing here recomputes a
 * total, and nothing here is allowed to write a figure onto a finalized
 * document — `invoice.paid_cents` and `invoice.status` are the two facts a
 * payment may change, and migration 0020 lets the immutability trigger
 * through for exactly those.
 */

/**
 * Who moved the money.
 *
 * `banktransfer` and `credit` have no API behind them: the first is the
 * customer paying into the operator's account and somebody booking it, the
 * second is the customer's own balance being spent. They are gateways all the
 * same, because the alternative is a second settlement path for the payments
 * that happen to have no provider — and a second settlement path is how an
 * invoice ends up paid twice.
 *
 * The enum is shared with `payment_method.provider`, where only `stripe` and
 * `paypal` can ever appear: there is no token to store for a transfer.
 */
export const paymentProvider = pgEnum("payment_provider", [
    "stripe",
    "paypal",
    "banktransfer",
    "credit",
]);

/** The gateways a payment method can belong to. */
export const STORABLE_PROVIDERS = ["stripe", "paypal"] as const;

export type PaymentProvider = (typeof paymentProvider.enumValues)[number];

/**
 * A payment method the customer left behind so a subscription can be
 * collected without them. The token is the provider's: a Stripe PaymentMethod
 * (pm_…) or a PayPal vault token. We never see a card number or an IBAN.
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
         * The one an automatic collection reaches for. At most one per
         * account is true — enforced by a partial unique index below, not by
         * the application, because two browser tabs are faster than a read
         * followed by a write.
         */
        isDefault: boolean("is_default").notNull().default(false),
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
    (table) => [
        index("payment_method_customer_id_idx").on(table.customerId),
        // At most one live default per account. A partial unique index,
        // because "default" is a property of the row that is still valid:
        // revoking a card must not block the next one from taking over.
        uniqueIndex("payment_method_one_default_idx")
            .on(table.customerId)
            .where(sql`"is_default" and "revoked_at" is null`),
    ],
);

export const paymentStatus = pgEnum("payment_status", [
    /** Started, customer is at the provider or the charge is in flight. */
    "pending",
    /** Accepted but not yet money — a SEPA debit takes days to settle. */
    "processing",
    "succeeded",
    "failed",
    /**
     * The whole charge went back out. A charge that was only partly refunded
     * stays `succeeded` and carries the amount in `refunded_cents`, because
     * it is still a payment — just a smaller one.
     */
    "refunded",
]);

/** Which direction the money went. */
export const paymentKind = pgEnum("payment_kind", ["charge", "refund"]);

/**
 * What the money was for. A top-up buys credit and has no invoice behind it,
 * which is the only reason `invoice_id` is nullable.
 */
export const paymentPurpose = pgEnum("payment_purpose", ["invoice", "topup"]);

/**
 * One movement of money: an attempt to pay one invoice, a refund of one such
 * attempt, or a top-up of the customer's balance. This is the "transaction"
 * `GET /api/v1/transactions` lists.
 *
 * Attempts are kept, not overwritten: a customer who abandons a checkout and
 * comes back leaves two rows, and the provider's own reference has to stay
 * resolvable for the books.
 */
export const payment = pgTable(
    "payment",
    {
        id: ulidPk("payment"),
        /** Null only for a top-up: money with no document behind it yet. */
        invoiceId: ulidFk("invoice_id").references(() => invoice.id, {
            onDelete: "restrict",
        }),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
        provider: paymentProvider("provider").notNull(),
        status: paymentStatus("status").notNull().default("pending"),
        kind: paymentKind("kind").notNull().default("charge"),
        purpose: paymentPurpose("purpose").notNull().default("invoice"),

        /** The charge this refund reverses. Null on a charge. */
        parentPaymentId: ulidFk("parent_payment_id").references(
            (): AnyPgColumn => payment.id,
            { onDelete: "restrict" },
        ),

        /** Set when the charge was collected from a stored method. */
        paymentMethodId: ulidFk("payment_method_id").references(
            () => paymentMethod.id,
            { onDelete: "set null" },
        ),

        /** Always positive. `kind` says which way it points. */
        amountCents: money("amount_cents").notNull(),
        /** How much of this charge has gone back out again. */
        refundedCents: money("refunded_cents").notNull().default(0),
        /** § 19 UStG: no tax anywhere, but the currency still has to match. */
        currency: text("currency").notNull().default("EUR"),

        /**
         * What we sent the customer to: a Checkout Session, a PayPal order,
         * a refund id — or, for a booking somebody typed in, the
         * idempotency token the form carried. Unique, and that uniqueness is
         * what makes settling the same thing twice impossible.
         */
        providerRef: text("provider_ref").notNull().unique(),
        /** What actually moved the money: PaymentIntent or PayPal capture. */
        captureRef: text("capture_ref").unique(),
        /** The provider's cut, in cents, once it is known. */
        feeCents: money("fee_cents"),

        failureCode: text("failure_code"),
        failureMessage: text("failure_message"),
        /** Free text from whoever booked it by hand. Never shown to a buyer. */
        note: text("note"),

        settledAt: timestamp("settled_at"),
        ...timestamps(),
    },
    (table) => [
        index("payment_invoice_id_idx").on(table.invoiceId),
        index("payment_customer_id_idx").on(table.customerId),
        index("payment_status_idx").on(table.status),
        index("payment_parent_idx").on(table.parentPaymentId),
    ],
);

/**
 * The customer's balance, as entries rather than a number.
 *
 * A balance column would have to be updated by every path that touches it and
 * would be wrong the first time one of them forgot; a ledger is wrong only if
 * a row is missing, and a missing row is visible. The balance is
 * `sum(amount_cents)` — positive is credit the customer holds, negative is
 * credit that has been spent.
 */
export const creditLedgerKind = pgEnum("credit_ledger_kind", [
    /** More money arrived than the invoice asked for. */
    "overpayment",
    /** The customer bought credit on purpose. */
    "topup",
    /** Credit spent on an invoice. */
    "applied",
    /** Credit paid back out to the customer. */
    "refund",
    /** Booked by hand, with a reason. */
    "adjustment",
]);

export const creditLedger = pgTable(
    "credit_ledger",
    {
        id: ulidPk("creditledger"),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
        kind: creditLedgerKind("kind").notNull(),
        /** Signed: positive is credit gained, negative is credit spent. */
        amountCents: money("amount_cents").notNull(),
        currency: text("currency").notNull().default("EUR"),

        /** The payment that produced it, where one did. */
        paymentId: ulidFk("payment_id").references(() => payment.id, {
            onDelete: "restrict",
        }),
        /** The invoice it came from or was spent on. */
        invoiceId: ulidFk("invoice_id").references(() => invoice.id, {
            onDelete: "restrict",
        }),

        /** Shown to the customer on their balance page. German. */
        reason: text("reason").notNull(),

        createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (table) => [
        index("credit_ledger_customer_id_idx").on(table.customerId),
        /**
         * One entry per payment and kind. A webhook delivered twice, or two
         * requests settling one invoice at once, would otherwise each write
         * the overpayment and double the customer's balance.
         */
        uniqueIndex("credit_ledger_payment_kind_idx")
            .on(table.paymentId, table.kind)
            .where(sql`"payment_id" is not null`),
    ],
);

/**
 * A chargeback. Its own table rather than a status on the payment, because a
 * dispute has a life of its own — a deadline to answer by, evidence, and an
 * outcome that arrives weeks later — and because one charge can be disputed,
 * won, and disputed again.
 */
export const disputeStatus = pgEnum("dispute_status", [
    "open",
    "under_review",
    "won",
    "lost",
    "withdrawn",
]);

export const paymentDispute = pgTable(
    "payment_dispute",
    {
        id: ulidPk("dispute"),
        paymentId: ulidFk("payment_id")
            .notNull()
            .references(() => payment.id, { onDelete: "restrict" }),
        provider: paymentProvider("provider").notNull(),
        /** The provider's own dispute id; unique, so an event cannot double. */
        providerRef: text("provider_ref").notNull().unique(),
        status: disputeStatus("status").notNull().default("open"),
        amountCents: money("amount_cents").notNull(),
        currency: text("currency").notNull().default("EUR"),
        /** The provider's reason code, verbatim. */
        reason: text("reason"),
        /** When evidence has to be with the provider. */
        respondBy: timestamp("respond_by"),
        openedAt: timestamp("opened_at").notNull().defaultNow(),
        closedAt: timestamp("closed_at"),
        ...timestamps(),
    },
    (table) => [index("payment_dispute_payment_id_idx").on(table.paymentId)],
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
 * Every webhook a provider has already delivered.
 *
 * Providers retry, and both of them say so plainly: the same event will
 * arrive twice. `handled_at` is what makes the dedupe honest — the row alone
 * would mean an event whose handler crashed halfway is never retried, because
 * the retry would find the row and answer 200 having done nothing. So the
 * claim is "insert, or take it back if nobody finished it", and only a
 * handler that ran to the end sets `handled_at`.
 *
 * Two deliveries racing can therefore both run the handler. That is deliberate
 * and cheap: `applyPayment` is idempotent under a row lock, which is where
 * double settlement is actually prevented. This table only keeps the common
 * case off the database.
 */
export const webhookEvent = pgTable(
    "webhook_event",
    {
        id: text("id").primaryKey(),
        provider: paymentProvider("provider").notNull(),
        type: text("type").notNull(),
        attempts: integer("attempts").notNull().default(1),
        handledAt: timestamp("handled_at"),
        receivedAt: timestamp("received_at").notNull().defaultNow(),
    },
    (table) => [index("webhook_event_received_at_idx").on(table.receivedAt)],
);

/**
 * Per-gateway configuration, including the credentials.
 *
 * Hard rule 6: the secrets are one AES-256-GCM blob (`src/lib/crypto.ts`,
 * `APP_ENCRYPTION_KEY`), never columns — a column invites a `select *` into a
 * log line, and the shape of what Stripe needs is not the shape of what
 * PayPal needs. The environment keeps working as the fallback, so a developer
 * with keys in `.env.local` needs no database row and a deployment can move
 * to the admin area without a migration of its secrets.
 */
export const gatewayMode = pgEnum("gateway_mode", ["sandbox", "live"]);

export const paymentGatewaySetting = pgTable("payment_gateway_setting", {
    /** The gateway id: `stripe`, `paypal`, `banktransfer`. */
    id: text("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    mode: gatewayMode("mode").notNull().default("sandbox"),
    /**
     * `v1.<key id>.<iv>.<ciphertext><tag>` over a JSON object. Null means
     * "nothing stored here; read the environment".
     */
    credentials: text("credentials"),
    /**
     * PayPal only: `vault` charges a stored wallet like Stripe does,
     * `subscriptions` hands the schedule to PayPal and maps the payments back
     * through `subscription.gateway_subscription_ref`. The account has to be
     * approved for reference transactions before `vault` works at all.
     */
    paypalRecurringMode: text("paypal_recurring_mode"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Our prices, as PayPal knows them.
 *
 * Only the `subscriptions` recurring mode needs this: there, PayPal runs the
 * schedule and wants a *plan* of its own per price. The plan is created once
 * and reused, keyed on everything that makes it a different plan — so a price
 * change creates a new plan rather than silently repricing the people already
 * on the old one, which is what PayPal would do if the key were the product.
 *
 * It is a cache of somebody else's ids, not a second price list. The money a
 * renewal asks for still comes from our own catalog.
 */
export const paypalPlan = pgTable("paypal_plan", {
    id: ulidPk("paypalplan"),
    /** `<cycle>:<cents>:<currency>:<mode>` — see `planKey()`. */
    planKey: text("plan_key").notNull().unique(),
    paypalProductId: text("paypal_product_id").notNull(),
    paypalPlanId: text("paypal_plan_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Payment = typeof payment.$inferSelect;
export type PaymentMethodRow = typeof paymentMethod.$inferSelect;
export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type PaymentDispute = typeof paymentDispute.$inferSelect;
export type PaymentGatewaySetting = typeof paymentGatewaySetting.$inferSelect;
