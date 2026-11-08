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

/**
 * The catalog: what is for sale, at which price, in which billing cycle, with
 * which add-ons, and which codes reduce it.
 *
 * Nothing here ever holds a computed total. A price is a row with a cycle and
 * a currency next to it, and every sum over those rows is produced by
 * `src/server/billing/pricing.ts` — the storefront, the checkout of Phase 4
 * and `POST /api/v1/products/{id}/quote` all call that one function, so a
 * price shown can never disagree with a price charged.
 */

/**
 * The periods a product can be billed in. `onetime` is here rather than in a
 * separate table because a one-off sale is a price for a product like any
 * other, and keeping it apart would mean every reader handling two shapes.
 */
export const billingCycle = pgEnum("billing_cycle", [
    "monthly",
    "quarterly",
    "semiannual",
    "annual",
    "biennial",
    "onetime",
]);

export type BillingCycle = (typeof billingCycle.enumValues)[number];

/** How many months one period of a cycle covers; `onetime` has no period. */
export const CYCLE_MONTHS: Record<BillingCycle, number | null> = {
    monthly: 1,
    quarterly: 3,
    semiannual: 6,
    annual: 12,
    biennial: 24,
    onetime: null,
};

export const productType = pgEnum("product_type", [
    "vps",
    "webhosting",
    "gameserver",
    "domain",
    /** A pure recurring product with nothing to provision — support plans,
     *  managed services, licences. It bills like the rest and simply never
     *  reaches a provisioning module. */
    "subscription",
    "other",
]);

export const productStatus = pgEnum("product_status", [
    /** Being prepared. Neither listed nor orderable. */
    "draft",
    /** Listed in the storefront and orderable. */
    "active",
    /** Orderable by direct link, kept out of the lists — a legacy tariff an
     *  existing customer is still allowed to take. */
    "hidden",
    /** No longer sold. Existing subscriptions keep running. */
    "retired",
]);

/**
 * Whether ordering a product sets its service up by itself.
 *
 * `manual` means a person accepts the order first, which is the right
 * default: an order nobody looked at is how a stolen card becomes a running
 * server. `auto_on_payment` is for products the operator is happy to hand
 * out the moment the money arrives — Phase 5 is what notices the payment,
 * Phase 8 what acts on it.
 */
export const provisioningMode = pgEnum("provisioning_mode", [
    "manual",
    "auto_on_payment",
]);

export const productGroup = pgTable(
    "product_group",
    {
        id: ulidPk("productgroup"),

        /** Stable handle for anchors and the `group=` filter of the API. */
        slug: text("slug").notNull().unique(),
        name: text("name").notNull(),
        /** One line under the heading in the group overview. */
        tagline: text("tagline"),
        description: text("description"),

        /** Ascending; the admin area moves a group by swapping two of these. */
        sortOrder: integer("sort_order").notNull().default(0),
        /** Kept out of the storefront without retiring its products. */
        hidden: boolean("hidden").notNull().default(false),

        ...timestamps(),
    },
    (table) => [index("product_group_sort_idx").on(table.sortOrder)],
);

export const product = pgTable(
    "product",
    {
        id: ulidPk("product"),
        groupId: ulidFk("group_id")
            .notNull()
            // Restrict: a group that still sells something must not be able
            // to take its products with it.
            .references(() => productGroup.id, { onDelete: "restrict" }),

        /** The storefront address: `/products/<slug>`. */
        slug: text("slug").notNull().unique(),
        name: text("name").notNull(),
        type: productType("type").notNull().default("other"),
        status: productStatus("status").notNull().default("draft"),

        tagline: text("tagline"),
        description: text("description"),
        sortOrder: integer("sort_order").notNull().default(0),

        /**
         * Which provisioning module runs when this is ordered. `none` means
         * nothing is provisioned, which is the whole of a `subscription`
         * product and the starting point for every other one until Phase 8
         * registers the Proxmox module.
         */
        module: text("module").notNull().default("none"),
        /**
         * The module's own settings, validated against the zod schema the
         * module publishes — see `src/server/provisioning`. A module that
         * does not recognise its configuration must not be able to store it.
         */
        moduleConfig: jsonb("module_config").notNull().default({}),

        /** How many of this a single order may take. */
        maxQuantity: integer("max_quantity").notNull().default(1),

        /**
         * How many days before a period starts its renewal invoice is
         * raised. Null takes the portal's setting (14 days by default).
         *
         * Per product because the notice a customer needs is a property of
         * what they bought: an annual plan at 400 € wants more warning than
         * a 5 € add-on. Where a subscription holds several products, the
         * longest of them wins — the earlier invoice is the one that gives
         * everybody enough time.
         */
        renewalLeadDays: integer("renewal_lead_days"),

        /**
         * Auto-provision on payment, or wait for a person. Snapshotted onto
         * every service at checkout, so changing it never reaches an order
         * that has already been placed.
         */
        provisioningMode: provisioningMode("provisioning_mode")
            .notNull()
            .default("manual"),

        /** Rule 10: never hard-delete something an invoice could point at. */
        deletedAt: timestamp("deleted_at"),

        ...timestamps(),
    },
    (table) => [
        index("product_group_id_idx").on(table.groupId),
        index("product_status_idx").on(table.status),
    ],
);

/**
 * The pricing matrix: one row per product × cycle × currency. A missing row
 * means that combination is not offered, which is what makes the matrix in
 * the admin area a grid of optional cells rather than a set of flags.
 */
export const productPricing = pgTable(
    "product_pricing",
    {
        id: ulidPk("productpricing"),
        productId: ulidFk("product_id")
            .notNull()
            .references(() => product.id, { onDelete: "cascade" }),

        cycle: billingCycle("cycle").notNull(),
        /** ISO 4217. Every amount in this row is in it. */
        currency: text("currency").notNull().default("EUR"),

        /** Recurring price for one period, in minor units. */
        priceCents: money("price_cents").notNull().default(0),
        /** Charged once, at the start. */
        setupFeeCents: money("setup_fee_cents").notNull().default(0),
        /** Free days before the first recurring charge; 0 means none. */
        trialDays: integer("trial_days").notNull().default(0),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("product_pricing_cell_idx").on(
            table.productId,
            table.cycle,
            table.currency,
        ),
    ],
);

export const configOptionType = pgEnum("config_option_type", [
    /** Exactly one of several values — a tariff size, a datacentre. */
    "select",
    /** One value, taken or not — a backup, a monitoring add-on. */
    "checkbox",
    /** One value, priced per unit — extra IPv4 addresses, extra RAM. */
    "quantity",
]);

export const configOption = pgTable(
    "config_option",
    {
        id: ulidPk("configoption"),
        productId: ulidFk("product_id")
            .notNull()
            .references(() => product.id, { onDelete: "cascade" }),

        name: text("name").notNull(),
        description: text("description"),
        type: configOptionType("type").notNull().default("select"),
        /** A required option has to be answered before the order is complete. */
        required: boolean("required").notNull().default(false),
        sortOrder: integer("sort_order").notNull().default(0),

        /** Bounds for `quantity` options; ignored by the other two. */
        minQuantity: integer("min_quantity").notNull().default(0),
        maxQuantity: integer("max_quantity").notNull().default(10),

        ...timestamps(),
    },
    (table) => [index("config_option_product_id_idx").on(table.productId)],
);

export const configOptionValue = pgTable(
    "config_option_value",
    {
        id: ulidPk("configoptionvalue"),
        optionId: ulidFk("option_id")
            .notNull()
            .references(() => configOption.id, { onDelete: "cascade" }),

        name: text("name").notNull(),
        sortOrder: integer("sort_order").notNull().default(0),
        /** Preselected in the storefront. At most one per option. */
        isDefault: boolean("is_default").notNull().default(false),

        ...timestamps(),
    },
    (table) => [index("config_option_value_option_id_idx").on(table.optionId)],
);

/**
 * An option value's own matrix. It is keyed by value rather than by option
 * because that is where the price actually differs — "16 GB" costs more than
 * "8 GB" — and because a `quantity` option prices one unit, which is one
 * value.
 */
export const configOptionPricing = pgTable(
    "config_option_pricing",
    {
        id: ulidPk("configoptionpricing"),
        valueId: ulidFk("value_id")
            .notNull()
            .references(() => configOptionValue.id, { onDelete: "cascade" }),

        cycle: billingCycle("cycle").notNull(),
        currency: text("currency").notNull().default("EUR"),

        priceCents: money("price_cents").notNull().default(0),
        setupFeeCents: money("setup_fee_cents").notNull().default(0),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("config_option_pricing_cell_idx").on(
            table.valueId,
            table.cycle,
            table.currency,
        ),
    ],
);

export const couponKind = pgEnum("coupon_kind", ["percent", "fixed"]);

export const couponDuration = pgEnum("coupon_duration", [
    /** The first billed period only. */
    "once",
    /** `durationPeriods` billed periods, counted from the first. */
    "repeating",
    /** Every period, for as long as the subscription runs. */
    "forever",
]);

export const coupon = pgTable(
    "coupon",
    {
        id: ulidPk("coupon"),

        /** Upper-cased on the way in, so the customer's typing does not matter. */
        code: text("code").notNull().unique(),
        description: text("description"),

        kind: couponKind("kind").notNull(),
        /**
         * Basis points for a percentage coupon: 2500 is 25 %, 1550 is 15,5 %.
         * An integer, because a percentage in a float is a rounding bug that
         * only shows up on one price in a hundred.
         */
        percentBasisPoints: integer("percent_basis_points"),
        /** Minor units for a fixed coupon, in `currency`. */
        amountCents: money("amount_cents"),
        /** Only meaningful for a fixed coupon; a percentage needs no currency. */
        currency: text("currency"),

        duration: couponDuration("duration").notNull().default("once"),
        /** Number of billed periods for `repeating`. */
        durationPeriods: integer("duration_periods"),

        /**
         * Whether the discount also reduces the setup fee. Off by default:
         * a Rabatt on the Einrichtungsgebühr is a separate decision from one
         * on the running price, and most are meant for the latter.
         */
        appliesToSetupFee: boolean("applies_to_setup_fee")
            .notNull()
            .default(false),

        /** Empty means every product; otherwise the product ids it is good for. */
        productIds: text("product_ids").array().notNull().default([]),
        /** Empty means every cycle. */
        cycles: text("cycles").array().notNull().default([]),

        validFrom: timestamp("valid_from"),
        validUntil: timestamp("valid_until"),
        /** null means unlimited. */
        maxRedemptions: integer("max_redemptions"),
        /** Counted up when an order uses the code — Phase 4 does the counting. */
        redemptions: integer("redemptions").notNull().default(0),

        active: boolean("active").notNull().default(true),

        ...timestamps(),
    },
    (table) => [index("coupon_active_idx").on(table.active)],
);

export type ProductGroup = typeof productGroup.$inferSelect;
export type Product = typeof product.$inferSelect;
export type ProductPricing = typeof productPricing.$inferSelect;
export type ConfigOption = typeof configOption.$inferSelect;
export type ConfigOptionValue = typeof configOptionValue.$inferSelect;
export type ConfigOptionPricing = typeof configOptionPricing.$inferSelect;
export type Coupon = typeof coupon.$inferSelect;
