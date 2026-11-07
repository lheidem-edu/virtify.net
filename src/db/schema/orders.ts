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
import { billingCycle, coupon, product } from "./catalog";
import { customer } from "./customers";
import { invoice } from "./invoices";

/**
 * The way something gets bought: a cart, and the order it becomes.
 *
 * **Neither table ever stores a price the browser sent.** A cart item is a
 * *configuration* — which product, which cycle, which options, how many —
 * and every figure shown for it is produced by `calculateQuote()` through
 * `quoteProduct()` at the moment it is shown. An order item, by contrast,
 * stores the figures, because an order is a record of what was agreed; they
 * are written by the checkout from that same function, inside the
 * transaction that also writes the invoice, so the two cannot disagree.
 *
 * That split is the whole point: nothing between the catalog and the invoice
 * is allowed to be a second opinion about a price.
 */

/**
 * A cart is open until it becomes an order. `merged` is a guest cart whose
 * items were moved into the account's cart when its owner signed in — kept
 * rather than deleted so the move is visible afterwards.
 */
export const cartStatus = pgEnum("cart_status", [
    "open",
    "ordered",
    "merged",
    "abandoned",
]);

export const cart = pgTable(
    "cart",
    {
        id: ulidPk("cart"),

        /**
         * SHA-256 of the secret in the `vfy_cart` cookie — the same treatment
         * API keys get, and for the same reason: a database dump must not
         * hand out live carts, and a guest cart is reachable by nothing but
         * this secret. The id is never the credential; it is time-ordered and
         * appears in the admin area.
         */
        tokenHash: text("token_hash").notNull().unique(),

        /** Null for a guest. Set when the cart is claimed by an account. */
        customerId: ulidFk("customer_id").references(() => customer.id, {
            onDelete: "cascade",
        }),

        status: cartStatus("status").notNull().default("open"),
        /** ISO 4217. Every item in the cart is priced in it. */
        currency: text("currency").notNull().default("EUR"),

        /** Where the items went, for `merged`; which order, for `ordered`. */
        mergedIntoCartId: ulidFk("merged_into_cart_id"),
        orderId: ulidFk("order_id"),

        /** Touched on every read, so an abandoned-cart sweep has a date. */
        lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),

        ...timestamps(),
    },
    (table) => [
        index("cart_customer_id_idx").on(table.customerId),
        index("cart_status_idx").on(table.status),
    ],
);

/**
 * One configured product in a cart. No prices here on purpose — see the
 * module docstring. `selections` holds ids only, so a price change or a
 * renamed option is picked up the next time the cart is priced rather than
 * being frozen into it.
 */
export const cartItem = pgTable(
    "cart_item",
    {
        id: ulidPk("cartitem"),
        cartId: ulidFk("cart_id")
            .notNull()
            .references(() => cart.id, { onDelete: "cascade" }),
        productId: ulidFk("product_id")
            .notNull()
            .references(() => product.id, { onDelete: "cascade" }),

        cycle: billingCycle("cycle").notNull(),
        currency: text("currency").notNull().default("EUR"),
        quantity: integer("quantity").notNull().default(1),

        /**
         * `[{ optionId, valueId, quantity }]` — exactly what the quote
         * request takes, and validated against the product every time it is
         * priced.
         */
        selections: jsonb("selections").notNull().default([]),

        /**
         * The code as it was typed. A coupon belongs to the item rather than
         * to the cart because `calculateQuote()` discounts one configured
         * product; a cart-level coupon would need a second arithmetic to
         * spread a fixed amount over several items, which is the one thing
         * this codebase does not allow itself.
         */
        couponCode: text("coupon_code"),

        ...timestamps(),
    },
    (table) => [index("cart_item_cart_id_idx").on(table.cartId)],
);

export const orderStatus = pgEnum("order_status", [
    /** Placed, not yet accepted. Nothing is provisioned in this state. */
    "pending",
    /** Accepted: the subscriptions run and the services may be provisioned. */
    "active",
    "cancelled",
    /** Refused as fraudulent. Subscriptions cancelled, services terminated. */
    "fraud",
]);

/**
 * How the order is to be paid. Only `bank_transfer` can be chosen today —
 * Stripe and PayPal are Phase 5 — but the values are declared now so adding
 * them is a line in a form rather than a migration that rewrites an enum.
 */
export const paymentOption = pgEnum("payment_option", [
    "bank_transfer",
    "stripe",
    "paypal",
]);

export const order = pgTable(
    "order",
    {
        id: ulidPk("order"),
        customerId: ulidFk("customer_id")
            .notNull()
            .references(() => customer.id, { onDelete: "restrict" }),

        /** `BS-{YEAR}-{0000}`, from the same gapless counter the documents use. */
        number: text("number").notNull().unique(),
        status: orderStatus("status").notNull().default("pending"),
        currency: text("currency").notNull().default("EUR"),

        /**
         * The first invoice, where there is one. An order whose whole first
         * charge is zero — everything on trial, or discounted to nothing —
         * issues no invoice at all rather than a 0,00 € document.
         */
        invoiceId: ulidFk("invoice_id").references(() => invoice.id, {
            onDelete: "set null",
        }),

        /**
         * Copied from the finalized invoice's own totals, so "the order total
         * equals the invoice total" is true by construction rather than by
         * two sums that have to be kept in step. All three are 0 when no
         * invoice was issued.
         */
        netCents: money("net_cents").notNull().default(0),
        taxCents: money("tax_cents").notNull().default(0),
        grossCents: money("gross_cents").notNull().default(0),

        paymentOption: paymentOption("payment_option")
            .notNull()
            .default("bank_transfer"),
        /**
         * The customer asked for recurring charges to be collected
         * automatically. Carried onto every subscription this order creates;
         * Phase 5 is what acts on it.
         */
        autoCharge: boolean("auto_charge").notNull().default(false),

        /**
         * What was accepted, and which fassung of it. The version is null
         * when the built-in wording was in force — a fresh installation has
         * published nothing — and `terms_label` says so in words, because
         * "Fassung null" is not an answer to give a judge.
         */
        termsDocumentId: ulidFk("terms_document_id"),
        termsVersion: integer("terms_version"),
        termsLabel: text("terms_label"),
        termsAcceptedAt: timestamp("terms_accepted_at").notNull(),
        /**
         * The Widerrufsbelehrung is § 20 of the AGB, so it carries the same
         * version; this is the second tick box, recorded separately because
         * it is a separate statement. Null for a Firma, which has no
         * Widerrufsrecht (§ 312g i. V. m. § 13 BGB).
         */
        withdrawalAcceptedAt: timestamp("withdrawal_accepted_at"),
        /**
         * § 356 Abs. 4 BGB: a consumer who wants the service before the
         * fourteen days are up has to ask for it expressly. Null for a Firma.
         */
        immediateStartRequestedAt: timestamp("immediate_start_requested_at"),
        /** Snapshot of `customer.kind`: whether the above applied at all. */
        isConsumer: boolean("is_consumer").notNull().default(true),

        /** Evidence for the acceptance above, and for a fraud review. */
        ip: text("ip"),
        userAgent: text("user_agent"),

        placedAt: timestamp("placed_at").notNull().defaultNow(),
        acceptedAt: timestamp("accepted_at"),
        cancelledAt: timestamp("cancelled_at"),
        /** Why it was cancelled or marked fraudulent. Internal. */
        decisionReason: text("decision_reason"),

        /** Internal only — never rendered in the customer area. */
        note: text("note"),

        ...timestamps(),
    },
    (table) => [
        index("order_customer_id_idx").on(table.customerId),
        index("order_status_idx").on(table.status),
        index("order_placed_at_idx").on(table.placedAt),
    ],
);

/**
 * One configured product as it was ordered, with the figures the quote
 * produced. These are a record, not an input: nothing recomputes from them,
 * and the subscription carries its own snapshot for renewals.
 */
export const orderItem = pgTable(
    "order_item",
    {
        id: ulidPk("orderitem"),
        orderId: ulidFk("order_id")
            .notNull()
            .references(() => order.id, { onDelete: "cascade" }),
        productId: ulidFk("product_id")
            .notNull()
            .references(() => product.id, { onDelete: "restrict" }),
        position: integer("position").notNull(),

        /** The product's name at the time of the order. */
        description: text("description").notNull(),
        cycle: billingCycle("cycle").notNull(),
        currency: text("currency").notNull().default("EUR"),
        quantity: integer("quantity").notNull().default(1),

        /** Catalog cell as it stood: per period, once, and the free days. */
        unitPriceCents: money("unit_price_cents").notNull(),
        setupFeeCents: money("setup_fee_cents").notNull().default(0),
        trialDays: integer("trial_days").notNull().default(0),

        /** One period, before and after the coupon. */
        recurringGrossCents: money("recurring_gross_cents")
            .notNull()
            .default(0),
        recurringDiscountCents: money("recurring_discount_cents")
            .notNull()
            .default(0),
        firstPeriodCents: money("first_period_cents").notNull().default(0),
        /** One period once the coupon stops applying. */
        renewalCents: money("renewal_cents").notNull().default(0),

        setupGrossCents: money("setup_gross_cents").notNull().default(0),
        setupDiscountCents: money("setup_discount_cents").notNull().default(0),
        setupCents: money("setup_cents").notNull().default(0),

        /**
         * What this item put on the first invoice — after proration, if the
         * first period was aligned to a billing day. The sum over the items
         * equals the invoice's net.
         */
        dueTodayCents: money("due_today_cents").notNull().default(0),

        couponId: ulidFk("coupon_id").references(() => coupon.id, {
            onDelete: "set null",
        }),
        couponCode: text("coupon_code"),
        /** How many periods the coupon covers; null means every one. */
        discountPeriods: integer("discount_periods"),

        /** The chosen add-ons, with the names and prices they had. */
        selections: jsonb("selections").notNull().default([]),
        /** The quote's own line breakdown, so the order renders as quoted. */
        lines: jsonb("lines").notNull().default([]),

        ...timestamps(),
    },
    (table) => [
        index("order_item_order_id_idx").on(table.orderId),
        uniqueIndex("order_item_position_idx").on(
            table.orderId,
            table.position,
        ),
    ],
);

export type Cart = typeof cart.$inferSelect;
export type CartItem = typeof cartItem.$inferSelect;
export type Order = typeof order.$inferSelect;
export type OrderItem = typeof orderItem.$inferSelect;
