import { sql } from "drizzle-orm";
import {
    index,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { money, timestamps, ulidFk, ulidPk } from "./_columns";
import { product } from "./catalog";
import { customer } from "./customers";
import { invoice } from "./invoices";
import { subscription, subscriptionItem } from "./subscriptions";

/**
 * The bookkeeping the recurring billing run needs in order to be run twice.
 *
 * Phase 6 is the first thing in this project that acts with nobody present:
 * a cron fires, invoices are issued and cards are charged. The one question
 * every table here answers is *"what stops this happening a second time?"*,
 * and the answer is never "the caller remembers" — it is a unique index the
 * writer has to pass.
 *
 *  - `subscription_invoice` — one renewal invoice per subscription per
 *    period, because `(subscription_id, period_start, kind)` is unique.
 *  - `invoice_collection` — one auto-charge per invoice per retry offset.
 *  - `dunning_action` — one reminder, one Mahnung, one suspension, one
 *    termination per invoice, ever.
 *  - `billing_run` — one run per day. This one is the *cheap* layer: it
 *    keeps a second cron pass off the database, and it is the only one of
 *    the four an operator may deliberately bypass ("jetzt abrechnen"). It
 *    is not what makes the run safe.
 */

/** Why an invoice was raised against a subscription. */
export const subscriptionInvoiceKind = pgEnum("subscription_invoice_kind", [
    /** The one the checkout issued: the first period, and the setup fees. */
    "initial",
    /** A period billed ahead by the daily run. */
    "renewal",
    /** The difference an immediate upgrade owes for the rest of a period. */
    "change",
    /** A Mahngebühr, which cannot be added to the invoice it belongs to. */
    "dunning_fee",
]);

/**
 * Which period of which subscription an invoice bills.
 *
 * A renewal invoice is grouped per customer and currency, so it may cover
 * several subscriptions at once and the link cannot live on the invoice row.
 * The unique index is the actual guarantee that a subscription's period is
 * invoiced once: two runs racing on the same day both reach it, and the
 * second one finds the row already there.
 *
 * It also makes "which subscription does this invoice belong to" a single
 * lookup — which is what dunning needs in order to suspend the right
 * service, and what an off-session collection needs in order to find the
 * right stored card.
 */
export const subscriptionInvoice = pgTable(
    "subscription_invoice",
    {
        id: ulidPk("subscriptioninvoice"),
        subscriptionId: ulidFk("subscription_id")
            .notNull()
            .references(() => subscription.id, { onDelete: "cascade" }),
        invoiceId: ulidFk("invoice_id")
            .notNull()
            .references(() => invoice.id, { onDelete: "restrict" }),
        kind: subscriptionInvoiceKind("kind").notNull().default("renewal"),

        /** The period this invoice pays for. `end` is exclusive, as always. */
        periodStart: timestamp("period_start").notNull(),
        periodEnd: timestamp("period_end"),

        /** What the lines of this invoice came to for this subscription. */
        netCents: money("net_cents").notNull().default(0),

        ...timestamps(),
    },
    (table) => [
        /**
         * The whole point of the table. A second run, a retried job and an
         * operator pressing the button all end here, and only one of them
         * can insert.
         */
        uniqueIndex("subscription_invoice_period_idx").on(
            table.subscriptionId,
            table.periodStart,
            table.kind,
        ),
        index("subscription_invoice_invoice_id_idx").on(table.invoiceId),
    ],
);

/**
 * Every state change a subscription has been through: the timeline the admin
 * detail page shows, and the record rule 8 asks for in a form a page can
 * render without reading the audit log.
 *
 * The audit log still gets its entry — this is not a replacement for it.
 * This one is the customer-facing history, and it is written by the one
 * function that may change a subscription's status.
 */
export const subscriptionEvent = pgTable(
    "subscription_event",
    {
        id: ulidPk("subscriptionevent"),
        subscriptionId: ulidFk("subscription_id")
            .notNull()
            .references(() => subscription.id, { onDelete: "cascade" }),

        /** `status`, `period`, `change`, `dunning`, `note`. */
        kind: text("kind").notNull(),
        fromStatus: text("from_status"),
        toStatus: text("to_status"),
        /** German — it is shown to the customer on their own detail page. */
        summary: text("summary").notNull(),
        data: jsonb("data").notNull().default({}),

        actorType: text("actor_type").notNull().default("system"),
        actorLabel: text("actor_label"),

        at: timestamp("at").notNull().defaultNow(),
        ...timestamps(),
    },
    (table) => [
        index("subscription_event_subscription_id_idx").on(
            table.subscriptionId,
        ),
    ],
);

export const subscriptionChangeStatus = pgEnum("subscription_change_status", [
    /** Agreed, and waiting for the period it takes effect in. */
    "pending",
    "applied",
    "cancelled",
]);

export const subscriptionChangeEffective = pgEnum(
    "subscription_change_effective",
    ["immediately", "period_end"],
);

/**
 * A plan change: a different product, a different quantity, different
 * add-ons. Stored even when it is applied at once, because what was agreed
 * and what it cost is the evidence behind a prorated line on an invoice.
 *
 * A change taken at the end of the period is a *promise*, and the run keeps
 * it in two steps, because the renewal invoice is raised days before the
 * period it bills: that invoice is built from the new configuration, and
 * the item and its services are rewritten when the period actually begins.
 * Until that instant the customer has paid for what they have, and a
 * machine taken away early cannot be given back.
 */
export const subscriptionChange = pgTable(
    "subscription_change",
    {
        id: ulidPk("subscriptionchange"),
        subscriptionId: ulidFk("subscription_id")
            .notNull()
            .references(() => subscription.id, { onDelete: "cascade" }),
        subscriptionItemId: ulidFk("subscription_item_id")
            .notNull()
            .references(() => subscriptionItem.id, { onDelete: "cascade" }),

        status: subscriptionChangeStatus("status").notNull().default("pending"),
        effective: subscriptionChangeEffective("effective").notNull(),

        /** `upgrade`, `downgrade` or `quantity` — what the figures said. */
        direction: text("direction").notNull(),

        /** What it changes to. The product may be the same one. */
        productId: ulidFk("product_id")
            .notNull()
            .references(() => product.id, { onDelete: "restrict" }),
        description: text("description").notNull(),
        quantity: integer("quantity").notNull(),
        selections: jsonb("selections").notNull().default([]),

        /** Per unit, per whole period, at the catalog price of the change. */
        unitPriceCents: money("unit_price_cents").notNull(),
        /** Base plus add-ons for one whole period, before any coupon. */
        recurringGrossCents: money("recurring_gross_cents").notNull(),

        /** What it cost for the rest of the running period, signed. */
        prorationCents: money("proration_cents").notNull().default(0),
        /** The invoice an immediate upgrade raised, where it raised one. */
        invoiceId: ulidFk("invoice_id").references(() => invoice.id, {
            onDelete: "set null",
        }),

        /** When it takes effect. Already past for an immediate change. */
        applyAt: timestamp("apply_at").notNull(),
        appliedAt: timestamp("applied_at"),

        ...timestamps(),
    },
    (table) => [
        index("subscription_change_subscription_id_idx").on(
            table.subscriptionId,
        ),
        /**
         * One pending change per item. A second one would be two promises
         * about the same line, and the renewal would have to guess which.
         * Partial, so the applied ones pile up as history.
         */
        uniqueIndex("subscription_change_one_pending_idx")
            .on(table.subscriptionItemId)
            .where(sql`"status" = 'pending'`),
    ],
);

export const billingRunStatus = pgEnum("billing_run_status", [
    "running",
    "finished",
    "failed",
]);

/**
 * One row per day the billing ran.
 *
 * The cheap layer, and nothing more: it keeps a second cron pass from doing
 * the work again, and it is what the Jobs page reads. Every actual guarantee
 * that a customer is invoiced once lives in the unique indexes above, because
 * an operator is allowed to force a run and a crashed run has to be
 * repeatable.
 */
export const billingRun = pgTable(
    "billing_run",
    {
        id: ulidPk("billingrun"),
        /** The Berlin calendar day, `YYYY-MM-DD`. */
        runDay: text("run_day").notNull(),
        status: billingRunStatus("status").notNull().default("running"),
        /** Whether a human asked for it outside the schedule. */
        forced: text("forced"),

        startedAt: timestamp("started_at").notNull().defaultNow(),
        finishedAt: timestamp("finished_at"),

        /** What it did, per step. Rendered on the Jobs page. */
        report: jsonb("report").notNull().default({}),
        error: text("error"),

        ...timestamps(),
    },
    (table) => [uniqueIndex("billing_run_day_idx").on(table.runDay)],
);

export const collectionStatus = pgEnum("invoice_collection_status", [
    "claimed",
    "succeeded",
    "processing",
    "requires_action",
    "failed",
    /** There was nothing to collect: no card, no auto-charge, nothing open. */
    "skipped",
]);

/**
 * One scheduled attempt to collect one invoice off a stored payment method.
 *
 * `offset_days` is the retry schedule — 0, 3 and 7 days after the due date by
 * default — and `(invoice_id, offset_days)` is unique, so each rung of the
 * ladder is climbed once however often the run passes over it. The row is
 * claimed *before* the gateway is called, which is the order that matters: a
 * worker that dies between the charge and the bookkeeping must not leave an
 * unclaimed rung behind for the next pass to charge again.
 */
export const invoiceCollection = pgTable(
    "invoice_collection",
    {
        id: ulidPk("invoicecollection"),
        invoiceId: ulidFk("invoice_id")
            .notNull()
            .references(() => invoice.id, { onDelete: "cascade" }),
        /** Days after the due date this rung sits at. */
        offsetDays: integer("offset_days").notNull(),

        status: collectionStatus("status").notNull().default("claimed"),
        amountCents: money("amount_cents").notNull().default(0),
        detail: text("detail"),

        dueAt: timestamp("due_at").notNull(),
        attemptedAt: timestamp("attempted_at"),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("invoice_collection_rung_idx").on(
            table.invoiceId,
            table.offsetDays,
        ),
    ],
);

export const dunningLevel = pgEnum("dunning_level", [
    /** A friendly reminder. No fee, no consequence. */
    "reminder",
    /** Mahnung — § 286 BGB, and where a Mahngebühr is raised if configured. */
    "mahnung",
    /** The services stop. */
    "suspend",
    /** The subscription ends and the services are terminated. */
    "terminate",
]);

/**
 * What dunning has already done to one invoice. `(invoice_id, level)` is
 * unique, so a customer is told once per rung however many times the run
 * sees the invoice still open.
 *
 * The invoice is never written to: a Mahngebühr is its own invoice, because
 * rule 3 means a finalized document does not grow a line. `fee_invoice_id`
 * points at it, and withdrawing the fee is a Rechnungskorrektur against
 * that document — the mirror of raising it, in the same table.
 */
export const dunningAction = pgTable(
    "dunning_action",
    {
        id: ulidPk("dunningaction"),
        invoiceId: ulidFk("invoice_id")
            .notNull()
            .references(() => invoice.id, { onDelete: "cascade" }),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
        level: dunningLevel("level").notNull(),

        /** The day the rung became due — due date plus the configured days. */
        dueAt: timestamp("due_at").notNull(),
        actedAt: timestamp("acted_at").notNull().defaultNow(),

        feeCents: money("fee_cents").notNull().default(0),
        feeInvoiceId: ulidFk("fee_invoice_id").references(() => invoice.id, {
            onDelete: "set null",
        }),
        /** Set when the fee was taken back by a Rechnungskorrektur. */
        feeWaivedAt: timestamp("fee_waived_at"),

        /** Whether the customer was actually told, and how. */
        notified: text("notified"),
        note: text("note"),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("dunning_action_level_idx").on(
            table.invoiceId,
            table.level,
        ),
        index("dunning_action_customer_id_idx").on(table.customerId),
    ],
);

export type SubscriptionInvoice = typeof subscriptionInvoice.$inferSelect;
export type SubscriptionEvent = typeof subscriptionEvent.$inferSelect;
export type SubscriptionChange = typeof subscriptionChange.$inferSelect;
export type BillingRun = typeof billingRun.$inferSelect;
export type InvoiceCollection = typeof invoiceCollection.$inferSelect;
export type DunningAction = typeof dunningAction.$inferSelect;
export type DunningLevel = (typeof dunningLevel.enumValues)[number];
