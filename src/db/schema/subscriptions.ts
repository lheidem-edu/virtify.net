import {
    boolean,
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
import { billingCycle, coupon, product, provisioningMode } from "./catalog";
import { customer } from "./customers";
import { order, orderItem } from "./orders";
import { paymentMethod } from "./payments";

/**
 * The Abo and the thing it pays for.
 *
 * A subscription is **our** billing contract, not a gateway's: it says what
 * is owed, for which period, at which price. A gateway only ever collects
 * money against it (Phase 5), and a provisioning module only ever runs
 * against a `service` (Phase 8). Both of those are allowed to fail without
 * the billing record becoming wrong.
 *
 * Phase 4 creates these at checkout and nothing renews them yet; the renewal
 * run, proration on upgrades and dunning are Phase 6. What matters here is
 * that every number a renewal will need is already snapshotted, because the
 * catalog is allowed to change underneath.
 */

export const subscriptionStatus = pgEnum("subscription_status", [
    /** Inside the free days; nothing has been billed for a period yet. */
    "trialing",
    "active",
    /** An invoice for it is overdue — Phase 6's dunning sets this. */
    "past_due",
    "paused",
    /** Will not renew; still running to the end of the paid period. */
    "cancelled",
    /** Over. */
    "ended",
]);

export const subscription = pgTable(
    "subscription",
    {
        id: ulidPk("subscription"),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
        /** The order it came from, where it came from one. */
        orderId: ulidFk("order_id").references(() => order.id, {
            onDelete: "set null",
        }),

        status: subscriptionStatus("status").notNull().default("active"),
        /** One subscription per billing cycle: a monthly and an annual item
         *  cannot share a period, so the checkout groups by this. */
        cycle: billingCycle("cycle").notNull(),
        currency: text("currency").notNull().default("EUR"),

        /**
         * The period currently paid for. `current_period_end` is exclusive —
         * it is the instant the next period starts — so two consecutive
         * periods neither overlap by a day nor leave one uncovered.
         */
        currentPeriodStart: timestamp("current_period_start").notNull(),
        currentPeriodEnd: timestamp("current_period_end"),
        /** When the next invoice is due to be raised. Null for a one-off. */
        nextBillingAt: timestamp("next_billing_at"),
        /** End of the free days, where the product granted any. */
        trialEndsAt: timestamp("trial_ends_at"),

        cancelAtPeriodEnd: boolean("cancel_at_period_end")
            .notNull()
            .default(false),

        /** The customer asked for renewals to be collected automatically. */
        autoCharge: boolean("auto_charge").notNull().default(false),
        paymentMethodId: ulidFk("payment_method_id").references(
            () => paymentMethod.id,
            { onDelete: "set null" },
        ),

        /** Set only where the gateway runs the schedule itself — Phase 5. */
        gateway: text("gateway"),
        gatewaySubscriptionRef: text("gateway_subscription_ref"),

        /**
         * The coupon that came with the order, and how many *further* periods
         * it still covers — null means every one, 0 means it is spent. The
         * period the checkout already billed is deducted when the row is
         * written, so Phase 6 can decrement without knowing how the order
         * went.
         */
        couponId: ulidFk("coupon_id").references(() => coupon.id, {
            onDelete: "set null",
        }),
        couponCode: text("coupon_code"),
        discountPeriodsRemaining: integer("discount_periods_remaining"),

        startedAt: timestamp("started_at").notNull().defaultNow(),
        cancelledAt: timestamp("cancelled_at"),
        endedAt: timestamp("ended_at"),

        note: text("note"),

        ...timestamps(),
    },
    (table) => [
        index("subscription_customer_id_idx").on(table.customerId),
        index("subscription_status_idx").on(table.status),
        index("subscription_next_billing_at_idx").on(table.nextBillingAt),
    ],
);

/**
 * What the subscription bills for, at the price it was sold at. The catalog
 * may be reprinted tomorrow; a running Abo is not repriced by it.
 */
export const subscriptionItem = pgTable(
    "subscription_item",
    {
        id: ulidPk("subscriptionitem"),
        subscriptionId: ulidFk("subscription_id")
            .notNull()
            .references(() => subscription.id, { onDelete: "cascade" }),
        productId: ulidFk("product_id")
            .notNull()
            .references(() => product.id, { onDelete: "restrict" }),
        /** The order line it was sold on. */
        orderItemId: ulidFk("order_item_id").references(() => orderItem.id, {
            onDelete: "set null",
        }),
        position: integer("position").notNull(),

        /** The product's name at the time of the sale. */
        description: text("description").notNull(),
        quantity: integer("quantity").notNull().default(1),

        /** Per unit, per period, as sold. */
        unitPriceCents: money("unit_price_cents").notNull(),
        /** What was charged once, at the start. Kept for the record only. */
        setupFeeCents: money("setup_fee_cents").notNull().default(0),
        /**
         * Base and add-ons for one period, before any coupon — what a
         * renewal invoice charges for this item.
         */
        recurringGrossCents: money("recurring_gross_cents")
            .notNull()
            .default(0),

        /** The chosen add-ons with the names and prices they were sold at. */
        selections: jsonb("selections").notNull().default([]),

        ...timestamps(),
    },
    (table) => [
        index("subscription_item_subscription_id_idx").on(table.subscriptionId),
        uniqueIndex("subscription_item_position_idx").on(
            table.subscriptionId,
            table.position,
        ),
    ],
);

export const serviceStatus = pgEnum("service_status", [
    /** Ordered, not yet set up. Everything starts here. */
    "pending",
    /** A module is working on it — Phase 8. */
    "provisioning",
    "active",
    "suspended",
    "terminated",
]);

/**
 * A provisioned thing: a VPS, a webspace, a game server. One per ordered
 * unit of a provisionable product, created `pending` at checkout — the
 * module that fills in the rest is Phase 8's.
 *
 * It points at the subscription item rather than the item pointing here: one
 * direction is one source of truth, and the item is what pays for it.
 */
export const service = pgTable(
    "service",
    {
        id: ulidPk("service"),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),
        subscriptionItemId: ulidFk("subscription_item_id").references(
            () => subscriptionItem.id,
            { onDelete: "set null" },
        ),
        productId: ulidFk("product_id")
            .notNull()
            .references(() => product.id, { onDelete: "restrict" }),

        status: serviceStatus("status").notNull().default("pending"),
        /** What the customer sees it called. */
        label: text("label").notNull(),

        /** The module that owns it, snapshotted from the product. */
        module: text("module").notNull().default("none"),
        /**
         * Whether it may be set up without a person looking at it, as the
         * product said at the time of the order. Snapshotted because
         * changing a product must not change how an order already placed is
         * treated.
         */
        provisioningMode: provisioningMode("provisioning_mode")
            .notNull()
            .default("manual"),

        /** Whatever the module needs to recognise it again. */
        moduleData: jsonb("module_data").notNull().default({}),
        /**
         * Rule 6: service passwords and tokens are AES-256-GCM ciphertext
         * from `src/lib/crypto.ts`, never plain text. Nothing writes it in
         * Phase 4 — the column exists so the module that does has nowhere
         * else to put them.
         */
        credentialsEncrypted: text("credentials_encrypted"),

        activatedAt: timestamp("activated_at"),
        suspendedAt: timestamp("suspended_at"),
        terminatedAt: timestamp("terminated_at"),

        note: text("note"),

        ...timestamps(),
    },
    (table) => [
        index("service_customer_id_idx").on(table.customerId),
        index("service_status_idx").on(table.status),
        index("service_subscription_item_id_idx").on(table.subscriptionItemId),
    ],
);

export type Subscription = typeof subscription.$inferSelect;
export type SubscriptionItem = typeof subscriptionItem.$inferSelect;
export type Service = typeof service.$inferSelect;
