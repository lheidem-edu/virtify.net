import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { add } from "@/lib/money";
import { createId } from "@/lib/ulid";
import {
    addCartItem,
    claimCartForCustomer,
    createCart,
    findCartByToken,
    findOpenCartForCustomer,
    loadCartItems,
} from "@/server/cart/repository";
import { priceCart } from "@/server/cart/view";
import { currentLegalVersion } from "@/server/legal/repository";
import { decideOrder, loadOrder } from "@/server/orders/repository";
import {
    OrderError,
    placeOrder,
    placeOrderFromItems,
} from "@/server/orders/service";
import { defaultSettings, type Settings } from "@/server/settings";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * The checkout, against a real Postgres.
 *
 * Every claim here is about what the database does when a sale happens: that
 * the order total *is* the invoice total because both come from one set of
 * lines, that a guest's basket survives signing in, that a trial is not
 * invoiced, and that two requests for the same cart produce one order and
 * not two. None of that can be proved against a stub.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the checkout proofs are being\n" +
            "        SKIPPED. Run `npm run db:up`.\n",
    );
}

const ACTOR = { type: "system" as const, label: "test" };
const AT = new Date("2026-11-07T10:00:00.000Z");

const SETTINGS: Settings = {
    ...defaultSettings,
    operator: {
        ...defaultSettings.operator,
        country: "DE",
        taxNumber: "305/5721/1234",
    },
};

/** The same settings with a billing anchor switched on. */
const ANCHORED: Settings = {
    ...SETTINGS,
    policy: { ...SETTINGS.policy, billingAnchorDay: 1 },
};

const ACCEPTED = {
    terms: true,
    withdrawal: true,
    immediateStart: true,
};

describe.skipIf(!available)("the checkout", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let customerId: string;
    let groupId: string;
    let vpsId: string;
    let planId: string;
    let annualId: string;

    async function customer(
        over: Partial<typeof schema.customer.$inferInsert> & {
            customerNumber: number;
        },
    ) {
        const userId = createId("user");

        await db.insert(schema.user).values({
            id: userId,
            name: `Kunde ${over.customerNumber}`,
            email: `kunde${over.customerNumber}@example.test`,
            emailVerified: true,
        });

        const [row] = await db
            .insert(schema.customer)
            .values({
                name: `Kunde ${over.customerNumber}`,
                kind: "private",
                country: "DE",
                street: "Musterweg 1",
                postalCode: "12345",
                city: "Musterstadt",
                ...over,
            })
            .returning();

        await db.insert(schema.customerContact).values({
            customerId: row.id,
            userId,
            role: "owner",
            email: `kunde${over.customerNumber}@example.test`,
        });

        return row.id;
    }

    async function product(over: {
        slug: string;
        name: string;
        type?: "vps" | "subscription";
        cycle: "monthly" | "annual" | "onetime";
        priceCents: number;
        setupFeeCents?: number;
        trialDays?: number;
        maxQuantity?: number;
    }) {
        const [row] = await db
            .insert(schema.product)
            .values({
                groupId,
                slug: over.slug,
                name: over.name,
                type: over.type ?? "vps",
                status: "active",
                maxQuantity: over.maxQuantity ?? 5,
            })
            .returning();

        await db.insert(schema.productPricing).values({
            productId: row.id,
            cycle: over.cycle,
            currency: "EUR",
            priceCents: over.priceCents,
            setupFeeCents: over.setupFeeCents ?? 0,
            trialDays: over.trialDays ?? 0,
        });

        return row.id;
    }

    /** A cart with one line, ready to be checked out. */
    async function cartWith(
        lines: {
            productId: string;
            cycle: "monthly" | "annual" | "onetime";
            quantity?: number;
            couponCode?: string;
        }[],
        owner: string | null = customerId,
    ) {
        const { cart, token } = await createCart(db, { customerId: owner });

        for (const line of lines) {
            await addCartItem(db, {
                cartId: cart.id,
                productId: line.productId,
                cycle: line.cycle,
                currency: "EUR",
                quantity: line.quantity ?? 1,
                selections: [],
                couponCode: line.couponCode ?? null,
            });
        }

        return { cart, token };
    }

    async function invoiceItemsOf(invoiceId: string) {
        return db
            .select()
            .from(schema.invoiceItem)
            .where(eq(schema.invoiceItem.invoiceId, invoiceId))
            .orderBy(asc(schema.invoiceItem.position));
    }

    beforeAll(async () => {
        const created = await createTestDatabase();

        db = created.db;
        drop = created.drop;

        customerId = await customer({ customerNumber: 10001 });

        const [group] = await db
            .insert(schema.productGroup)
            .values({ slug: "vps", name: "KVM-Instanzen" })
            .returning();

        groupId = group.id;

        // 19,99 €/Monat, 10,00 € Einrichtung.
        vpsId = await product({
            slug: "vps-m",
            name: "VPS M",
            cycle: "monthly",
            priceCents: 1999,
            setupFeeCents: 1000,
        });

        // A pure subscription: nothing to provision, no setup fee.
        planId = await product({
            slug: "support",
            name: "Supportvertrag",
            type: "subscription",
            cycle: "monthly",
            priceCents: 2500,
        });

        // 199,90 €/Jahr with 14 free days.
        annualId = await product({
            slug: "vps-m-annual",
            name: "VPS M (jährlich)",
            cycle: "annual",
            priceCents: 19_990,
            trialDays: 14,
        });
    }, 60_000);

    afterAll(async () => {
        await drop?.();
    });

    beforeEach(async () => {
        /**
         * Each case starts from a clean slate of sales; the catalog and the
         * accounts stay.
         *
         * TRUNCATE rather than DELETE, and deliberately: the immutability
         * triggers of Phase 3 refuse a DELETE on a finalized invoice and on
         * every one of its positions, which is exactly what they are for.
         * TRUNCATE fires statement triggers, not row triggers, so the
         * fixture can start over without the triggers being weakened for
         * the code under test.
         */
        await db.execute(sql`
            truncate table
                "service", "subscription_item", "subscription",
                "order_item", "order",
                "credit_note_item", "credit_note",
                "invoice_item", "invoice",
                "cart_item", "cart",
                "coupon", "document_counter"
            cascade
        `);
    });

    it("writes an order whose total is the invoice's total", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly" },
        ]);

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        // 19,99 € + 10,00 € = 29,99 €, and no VAT under § 19 UStG.
        expect(placed.netCents).toBe(2999);
        expect(placed.taxCents).toBe(0);
        expect(placed.grossCents).toBe(2999);
        expect(placed.number).toBe("BS-2026-0001");
        expect(placed.invoiceNumber).toBe("RE-2026-0001");

        const [order] = await db
            .select()
            .from(schema.order)
            .where(eq(schema.order.id, placed.orderId));

        const [invoice] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, placed.invoiceId as string));

        expect(order.netCents).toBe(invoice.netCents);
        expect(order.taxCents).toBe(invoice.taxCents);
        expect(order.grossCents).toBe(invoice.grossCents);
        expect(invoice.status).toBe("unpaid");
        expect(order.status).toBe("pending");

        // And the per-item figures add up to the same number, so the order's
        // own breakdown reconciles with the document line for line.
        const items = await db
            .select()
            .from(schema.orderItem)
            .where(eq(schema.orderItem.orderId, order.id));

        expect(add(...items.map((item) => item.dueTodayCents))).toBe(
            invoice.netCents,
        );

        const lines = await invoiceItemsOf(invoice.id);

        expect(lines.map((line) => line.description)).toEqual([
            "VPS M",
            "Einrichtung: VPS M",
        ]);
        expect(lines[0].unitCode).toBe("MON");
        expect(add(...lines.map((line) => line.netCents ?? 0))).toBe(2999);
        // The tax snapshot is the engine's, frozen at finalization.
        expect(lines[0].taxStrategy).toBe("kleinunternehmer");
        expect(lines[0].taxRateBp).toBe(0);
        expect(lines[0].taxCategory).toBe("E");
    });

    it("creates one subscription per billing rhythm, with its prices frozen", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly", quantity: 2 },
            { productId: planId, cycle: "monthly" },
            { productId: annualId, cycle: "annual" },
        ]);

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: true,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        const subscriptions = await db
            .select()
            .from(schema.subscription)
            .where(eq(schema.subscription.orderId, placed.orderId))
            .orderBy(asc(schema.subscription.id));

        // The two monthly items share a rhythm; the annual one is on a trial
        // and a different cycle, so it cannot share either.
        expect(subscriptions).toHaveLength(2);

        const monthly = subscriptions.find((row) => row.cycle === "monthly");
        const annual = subscriptions.find((row) => row.cycle === "annual");

        expect(monthly?.status).toBe("active");
        expect(monthly?.autoCharge).toBe(true);
        expect(monthly?.trialEndsAt).toBeNull();
        expect(annual?.status).toBe("trialing");
        expect(annual?.trialEndsAt?.toISOString()).toBe(
            "2026-11-21T10:00:00.000Z",
        );

        const monthlyItems = await db
            .select()
            .from(schema.subscriptionItem)
            .where(
                eq(
                    schema.subscriptionItem.subscriptionId,
                    monthly?.id as string,
                ),
            )
            .orderBy(asc(schema.subscriptionItem.position));

        expect(monthlyItems).toHaveLength(2);
        expect(monthlyItems[0]).toMatchObject({
            description: "VPS M",
            quantity: 2,
            unitPriceCents: 1999,
            setupFeeCents: 2000,
            // Two of them, per period, before any coupon.
            recurringGrossCents: 3998,
        });
        expect(monthlyItems[1]).toMatchObject({
            description: "Supportvertrag",
            quantity: 1,
            unitPriceCents: 2500,
            recurringGrossCents: 2500,
        });
    });

    it("puts a service in `pending` per unit, and none for a pure subscription", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly", quantity: 3 },
            { productId: planId, cycle: "monthly" },
        ]);

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        const services = await db
            .select()
            .from(schema.service)
            .where(eq(schema.service.customerId, customerId))
            .orderBy(asc(schema.service.id));

        // Three machines, not one row for three of them — and nothing at all
        // for the support plan, which has no machine behind it.
        expect(services).toHaveLength(3);
        expect(services.map((row) => row.label)).toEqual([
            "VPS M (1/3)",
            "VPS M (2/3)",
            "VPS M (3/3)",
        ]);
        expect(services.every((row) => row.status === "pending")).toBe(true);
        expect(services.every((row) => row.provisioningMode === "manual")).toBe(
            true,
        );
        expect(placed.serviceIds).toHaveLength(3);
    });

    it("issues no invoice at all when a trial means nothing is due", async () => {
        const { cart } = await cartWith([
            { productId: annualId, cycle: "annual" },
        ]);

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        // A 0,00 € document is noise, not a record. The subscription carries
        // the obligation and the first invoice comes when the trial ends.
        expect(placed.invoiceId).toBeNull();
        expect(placed.netCents).toBe(0);
        expect(placed.grossCents).toBe(0);

        const invoices = await db.select().from(schema.invoice);

        expect(invoices).toHaveLength(0);

        // And no invoice number was burned either.
        const counters = await db.select().from(schema.documentCounter);

        expect(counters.map((row) => row.scope)).toEqual(["order:2026"]);

        const [subscription] = await db
            .select()
            .from(schema.subscription)
            .where(eq(schema.subscription.orderId, placed.orderId));

        expect(subscription.status).toBe("trialing");

        // The current period is the trial the customer is actually in, and
        // the next invoice falls due the day it ends — not a whole year
        // after that. Billing a cycle from the trial's end would have left
        // the first paid period covered by no document at all, and the order
        // page would have promised "nächste Abrechnung 21.11.2027" directly
        // under a cart that said the first charge comes after 14 free days.
        expect(subscription.currentPeriodStart.toISOString()).toBe(
            AT.toISOString(),
        );
        expect(subscription.trialEndsAt?.toISOString()).toBe(
            "2026-11-21T10:00:00.000Z",
        );
        expect(subscription.currentPeriodEnd?.toISOString()).toBe(
            "2026-11-21T10:00:00.000Z",
        );
        expect(subscription.nextBillingAt?.toISOString()).toBe(
            "2026-11-21T10:00:00.000Z",
        );
    });

    it("prorates the first period to the billing anchor", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly" },
        ]);

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: ANCHORED },
        );

        // 7 November to 1 December: 24 of 30 days. 19,99 € × 24/30 → 15,99 €,
        // plus the whole Einrichtungsgebühr, which is not a span of time.
        expect(placed.netCents).toBe(2599);

        const lines = await invoiceItemsOf(placed.invoiceId as string);

        expect(lines[0].unitPriceCents).toBe(1599);
        expect(lines[0].detail).toContain("anteilig für 24 von 30 Tagen");
        expect(lines[1].unitPriceCents).toBe(1000);

        const [subscription] = await db
            .select()
            .from(schema.subscription)
            .where(eq(schema.subscription.orderId, placed.orderId));

        // The short period ends at the anchor, and every one after it runs
        // from stichtag to stichtag.
        expect(subscription.currentPeriodEnd?.toISOString()).toBe(
            "2026-11-30T23:00:00.000Z",
        );
    });

    /**
     * The rule the whole panel rests on: the figure the customer confirmed
     * is the figure the invoice charges. Proration used to happen only when
     * the invoice was built, so with a billing anchor set the cart said
     * 29,99 € and the invoice said 25,99 € — the panel quietly charging
     * something other than what was on the screen.
     */
    it("charges the figure the cart and the checkout showed", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly" },
        ]);

        const items = await loadCartItems(db, cart.id);
        const shown = await priceCart(db, cart, items, {
            now: AT,
            anchorDay: ANCHORED.policy.billingAnchorDay,
        });

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: ANCHORED },
        );

        expect(shown.dueTodayCents).toBe(2599);
        expect(placed.netCents).toBe(shown.dueTodayCents);

        const [invoice] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, placed.invoiceId as string));

        expect(invoice.grossCents).toBe(shown.dueTodayCents);
    });

    /**
     * A fixed coupon is capped against the amount actually being charged.
     * While the discount was computed on a whole period and the base lines
     * were prorated afterwards, a code covering the full period could come
     * out larger than the stub it was discounting and finalize an invoice
     * over minus one cent — with a gapless number on it.
     */
    it("cannot discount a short first period below nothing", async () => {
        await db.insert(schema.coupon).values({
            code: "GANZEPERIODE",
            kind: "fixed",
            amountCents: 2000,
            duration: "once",
            active: true,
            appliesToSetupFee: false,
        });

        const tenEuro = await product({
            slug: "zehn",
            name: "Zehn",
            cycle: "monthly",
            priceCents: 1000,
        });

        const { cart } = await cartWith([
            {
                productId: tenEuro,
                cycle: "monthly",
                quantity: 2,
                couponCode: "GANZEPERIODE",
            },
        ]);

        // 30 November with the anchor on the 1st: one day of thirty.
        const lateNovember = new Date("2026-11-30T10:00:00.000Z");

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: lateNovember, settings: ANCHORED },
        );

        expect(placed.netCents).toBe(0);
        expect(placed.grossCents).toBeGreaterThanOrEqual(0);
    });

    it("issues no invoice when a coupon discounts the whole order away", async () => {
        await db.insert(schema.coupon).values({
            code: "GRATIS",
            kind: "percent",
            percentBasisPoints: 10_000,
            duration: "once",
            active: true,
            appliesToSetupFee: true,
        });

        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly", couponCode: "GRATIS" },
        ]);

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        // Two lines that cancel are still nothing owed, so there is no
        // document — and no gapless number burned on one demanding 0,00 €.
        expect(placed.invoiceId).toBeNull();
        expect(placed.netCents).toBe(0);

        const counters = await db.select().from(schema.documentCounter);

        expect(counters.map((row) => row.scope)).toEqual(["order:2026"]);
    });

    /**
     * The lock is on the `cart` row; Postgres does not extend it to
     * `cart_item`, so a second tab can add a line mid-checkout and have it
     * stranded in a cart that is about to be closed.
     */
    it("refuses to close a cart that grew while the order was being placed", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly" },
        ]);

        // Stands in for the other tab's insert, which commits on its own
        // connection while this transaction is still running.
        await addCartItem(db, {
            cartId: cart.id,
            productId: planId,
            cycle: "monthly",
            currency: "EUR",
            quantity: 1,
            selections: [],
            couponCode: null,
        });

        const items = await loadCartItems(db, cart.id);

        expect(items).toHaveLength(2);

        // Both lines are now priced and ordered together — the point is that
        // the count is re-read under the lock rather than trusted from the
        // first read. Removing one between the two reads must stop the sale.
        await db
            .delete(schema.cartItem)
            .where(eq(schema.cartItem.id, items[1].id));

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        // One line left, one line ordered: the count matches and it goes
        // through. The guard only fires when the two disagree.
        const [closed] = await db
            .select()
            .from(schema.cart)
            .where(eq(schema.cart.id, cart.id));

        expect(closed.status).toBe("ordered");
        expect(placed.netCents).toBe(2999);
    });

    it("records the AGB fassung the buyer was shown, not a newer one", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly" },
        ]);

        await expect(
            placeOrder(
                db,
                {
                    cartId: cart.id,
                    customerId,
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: {
                        ...ACCEPTED,
                        // What the page printed under the tick box before a
                        // new fassung took effect.
                        termsLabel: "Fassung von gestern",
                    },
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            ),
        ).rejects.toThrow(/inzwischen geändert/);

        // Agreeing to the fassung actually in force goes through.
        const current = await currentLegalVersion(db, "terms");

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: { ...ACCEPTED, termsLabel: current.label },
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        const loaded = await loadOrder(placed.orderId, "", true, db);

        expect(loaded?.order.termsLabel).toBe(current.label);
    });

    it("names an unknown account rather than failing on its foreign key", async () => {
        await expect(
            placeOrderFromItems(
                db,
                {
                    customerId: "customer_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                    items: [
                        {
                            productId: vpsId,
                            cycle: "monthly",
                            currency: "EUR",
                            quantity: 1,
                            options: [],
                        },
                    ],
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: ACCEPTED,
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            ),
            // Not a constraint violation out of the cart insert, which the
            // API route would have had to answer with a bare 500.
        ).rejects.toBeInstanceOf(OrderError);
    });

    it("redeems a coupon once per order and refuses one that is used up", async () => {
        const [coupon] = await db
            .insert(schema.coupon)
            .values({
                code: "WILLKOMMEN",
                kind: "percent",
                percentBasisPoints: 2500,
                duration: "once",
                maxRedemptions: 1,
            })
            .returning();

        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly", couponCode: "WILLKOMMEN" },
            { productId: planId, cycle: "monthly", couponCode: "WILLKOMMEN" },
        ]);

        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId,
                paymentOption: "bank_transfer",
                autoCharge: false,
                acceptance: ACCEPTED,
            },
            ACTOR,
            { now: AT, settings: SETTINGS },
        );

        // 25 % of 19,99 € → 5,00 €; 25 % of 25,00 € → 6,25 €. The
        // Einrichtungsgebühr is untouched: this code does not say it may.
        expect(placed.netCents).toBe(1499 + 1000 + 1875);

        const [after] = await db
            .select()
            .from(schema.coupon)
            .where(eq(schema.coupon.id, coupon.id));

        // Two lines carried the code; one order redeemed it.
        expect(after.redemptions).toBe(1);

        const second = await cartWith([
            { productId: vpsId, cycle: "monthly", couponCode: "WILLKOMMEN" },
        ]);

        await expect(
            placeOrder(
                db,
                {
                    cartId: second.cart.id,
                    customerId,
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: ACCEPTED,
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            ),
            // The code is refused outright rather than silently dropped:
            // an order that charges the undiscounted price is the panel
            // taking more than the screen said a moment earlier.
        ).rejects.toThrow(/gilt für diese Bestellung nicht/);
    });

    it("lets two requests for the same cart produce exactly one order", async () => {
        const { cart } = await cartWith([
            { productId: vpsId, cycle: "monthly" },
        ]);

        const attempt = () =>
            placeOrder(
                db,
                {
                    cartId: cart.id,
                    customerId,
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: ACCEPTED,
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            );

        const results = await Promise.allSettled([attempt(), attempt()]);

        expect(
            results.filter((entry) => entry.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
            results.filter((entry) => entry.status === "rejected"),
        ).toHaveLength(1);

        const orders = await db.select().from(schema.order);
        const invoices = await db.select().from(schema.invoice);

        // One order, one invoice, one number out of each counter.
        expect(orders).toHaveLength(1);
        expect(invoices).toHaveLength(1);
        expect(orders[0].number).toBe("BS-2026-0001");
        expect(invoices[0].number).toBe("RE-2026-0001");

        const [closed] = await db
            .select()
            .from(schema.cart)
            .where(eq(schema.cart.id, cart.id));

        expect(closed.status).toBe("ordered");
        expect(closed.orderId).toBe(orders[0].id);
    });

    it("refuses a cart that belongs to another account", async () => {
        const otherId = await customer({ customerNumber: 10002 });
        const { cart } = await cartWith(
            [{ productId: vpsId, cycle: "monthly" }],
            otherId,
        );

        await expect(
            placeOrder(
                db,
                {
                    cartId: cart.id,
                    customerId,
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: ACCEPTED,
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            ),
        ).rejects.toThrow(/anderen Konto/);
    });

    describe("what has to be confirmed", () => {
        it("refuses an order without the AGB", async () => {
            const { cart } = await cartWith([
                { productId: vpsId, cycle: "monthly" },
            ]);

            await expect(
                placeOrder(
                    db,
                    {
                        cartId: cart.id,
                        customerId,
                        paymentOption: "bank_transfer",
                        autoCharge: false,
                        acceptance: { ...ACCEPTED, terms: false },
                    },
                    ACTOR,
                    { now: AT, settings: SETTINGS },
                ),
            ).rejects.toThrow(/Geschäftsbedingungen/);
        });

        it("refuses a consumer's order without the Widerrufsbelehrung", async () => {
            const { cart } = await cartWith([
                { productId: vpsId, cycle: "monthly" },
            ]);

            await expect(
                placeOrder(
                    db,
                    {
                        cartId: cart.id,
                        customerId,
                        paymentOption: "bank_transfer",
                        autoCharge: false,
                        acceptance: { ...ACCEPTED, withdrawal: false },
                    },
                    ACTOR,
                    { now: AT, settings: SETTINGS },
                ),
            ).rejects.toThrow(/Widerrufsbelehrung/);
        });

        it("does not ask a Firma for one — it has no Widerrufsrecht", async () => {
            const firmaId = await customer({
                customerNumber: 10003,
                kind: "company",
                company: "Beispiel GmbH",
            });

            const { cart } = await cartWith(
                [{ productId: vpsId, cycle: "monthly" }],
                firmaId,
            );

            const placed = await placeOrder(
                db,
                {
                    cartId: cart.id,
                    customerId: firmaId,
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: {
                        terms: true,
                        withdrawal: false,
                        immediateStart: false,
                    },
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            );

            const [order] = await db
                .select()
                .from(schema.order)
                .where(eq(schema.order.id, placed.orderId));

            expect(order.isConsumer).toBe(false);
            expect(order.withdrawalAcceptedAt).toBeNull();
            expect(order.immediateStartRequestedAt).toBeNull();
            // The fassung that was shown is recorded either way.
            expect(order.termsAcceptedAt).toEqual(AT);
            expect(order.termsLabel).toContain("Eingebaute Fassung");
        });

        it("refuses an order from an account without a full address", async () => {
            const [incomplete] = await db
                .insert(schema.customer)
                .values({
                    name: "Ohne Anschrift",
                    customerNumber: 10004,
                    country: "DE",
                })
                .returning();

            const { cart } = await cartWith(
                [{ productId: vpsId, cycle: "monthly" }],
                incomplete.id,
            );

            await expect(
                placeOrder(
                    db,
                    {
                        cartId: cart.id,
                        customerId: incomplete.id,
                        paymentOption: "bank_transfer",
                        autoCharge: false,
                        acceptance: ACCEPTED,
                    },
                    ACTOR,
                    { now: AT, settings: SETTINGS },
                ),
            ).rejects.toThrow(/Rechnungsanschrift/);
        });
    });

    describe("the guest cart", () => {
        it("becomes the account's own when there is none yet", async () => {
            const guestId = await customer({ customerNumber: 10010 });
            const { cart, token } = await cartWith(
                [{ productId: vpsId, cycle: "monthly" }],
                null,
            );

            const result = await db.transaction((tx) =>
                claimCartForCustomer(tx, cart.id, guestId),
            );

            expect(result.cartId).toBe(cart.id);
            expect(result.merged).toBe(0);

            // The cookie still resolves it, because it is the same cart.
            const found = await findCartByToken(db, token);

            expect(found?.id).toBe(cart.id);
            expect(found?.customerId).toBe(guestId);
        });

        it("is merged into the account's cart when there is one", async () => {
            const ownerId = await customer({ customerNumber: 10011 });

            const own = await cartWith(
                [{ productId: planId, cycle: "monthly" }],
                ownerId,
            );
            const guest = await cartWith(
                [{ productId: vpsId, cycle: "monthly", quantity: 2 }],
                null,
            );

            const result = await db.transaction((tx) =>
                claimCartForCustomer(tx, guest.cart.id, ownerId),
            );

            expect(result.cartId).toBe(own.cart.id);
            expect(result.merged).toBe(1);

            const items = await loadCartItems(db, own.cart.id);

            expect(items).toHaveLength(2);
            expect(items.map((item) => item.productId).sort()).toEqual(
                [planId, vpsId].sort(),
            );

            const [closed] = await db
                .select()
                .from(schema.cart)
                .where(eq(schema.cart.id, guest.cart.id));

            expect(closed.status).toBe("merged");
            expect(closed.mergedIntoCartId).toBe(own.cart.id);

            // The guest cart's cookie no longer resolves anything, and the
            // account's own cart is what the next read finds.
            expect(await findCartByToken(db, guest.token)).toBeNull();
            expect((await findOpenCartForCustomer(db, ownerId))?.id).toBe(
                own.cart.id,
            );
        });

        it("is never claimed away from another account", async () => {
            const oneId = await customer({ customerNumber: 10012 });
            const twoId = await customer({ customerNumber: 10013 });

            const theirs = await cartWith(
                [{ productId: vpsId, cycle: "monthly" }],
                oneId,
            );

            // A shared browser: somebody else's cookie is still lying there.
            const result = await db.transaction((tx) =>
                claimCartForCustomer(tx, theirs.cart.id, twoId),
            );

            expect(result.cartId).toBeNull();

            const [untouched] = await db
                .select()
                .from(schema.cart)
                .where(eq(schema.cart.id, theirs.cart.id));

            expect(untouched.customerId).toBe(oneId);
            expect(untouched.status).toBe("open");
        });

        it("merges twice without doubling anything", async () => {
            const ownerId = await customer({ customerNumber: 10014 });
            const own = await cartWith(
                [{ productId: planId, cycle: "monthly" }],
                ownerId,
            );
            const guest = await cartWith(
                [{ productId: vpsId, cycle: "monthly" }],
                null,
            );

            await db.transaction((tx) =>
                claimCartForCustomer(tx, guest.cart.id, ownerId),
            );
            await db.transaction((tx) =>
                claimCartForCustomer(tx, guest.cart.id, ownerId),
            );

            // The merge runs on whatever page is rendered after signing in,
            // which may be rendered more than once.
            expect(await loadCartItems(db, own.cart.id)).toHaveLength(2);
        });
    });

    describe("deciding an order", () => {
        async function pending() {
            const { cart } = await cartWith([
                { productId: vpsId, cycle: "monthly" },
            ]);

            return placeOrder(
                db,
                {
                    cartId: cart.id,
                    customerId,
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: ACCEPTED,
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            );
        }

        it("accepting leaves the subscriptions and services running", async () => {
            const placed = await pending();

            await decideOrder(db, placed.orderId, "accept", ACTOR);

            const loaded = await loadOrder(placed.orderId, "", true, db);

            expect(loaded?.order.status).toBe("active");
            expect(loaded?.order.acceptedAt).not.toBeNull();
            expect(loaded?.subscriptions[0]?.subscription.status).toBe(
                "active",
            );
            expect(loaded?.services[0]?.status).toBe("pending");
        });

        it("marking fraud cancels the subscriptions and terminates the services", async () => {
            const placed = await pending();

            await decideOrder(db, placed.orderId, "fraud", ACTOR, {
                reason: "Karte gemeldet",
            });

            const loaded = await loadOrder(placed.orderId, "", true, db);

            expect(loaded?.order.status).toBe("fraud");
            expect(loaded?.order.decisionReason).toBe("Karte gemeldet");
            expect(loaded?.subscriptions[0]?.subscription.status).toBe(
                "cancelled",
            );
            expect(
                loaded?.subscriptions[0]?.subscription.nextBillingAt,
            ).toBeNull();
            expect(loaded?.services[0]?.status).toBe("terminated");

            // The invoice is untouched: a finalized document is corrected by
            // a Rechnungskorrektur and by nothing else.
            const [invoice] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, placed.invoiceId as string));

            expect(invoice.status).toBe("unpaid");
            expect(invoice.number).toBe("RE-2026-0001");
        });

        it("cannot be decided twice", async () => {
            const placed = await pending();

            await decideOrder(db, placed.orderId, "cancel", ACTOR);

            await expect(
                decideOrder(db, placed.orderId, "accept", ACTOR),
            ).rejects.toBeInstanceOf(OrderError);
        });
    });

    describe("ordering without a cart in a browser", () => {
        it("takes the same path and leaves no cart behind on failure", async () => {
            const placed = await placeOrderFromItems(
                db,
                {
                    customerId,
                    items: [
                        {
                            productId: "vps-m",
                            cycle: "monthly",
                            currency: "EUR",
                            quantity: 1,
                            options: [],
                        },
                    ],
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: ACCEPTED,
                },
                ACTOR,
                { now: AT, settings: SETTINGS },
            );

            expect(placed.netCents).toBe(2999);

            // The cart it went through is closed, not left open where the
            // customer would find it again in the storefront.
            const carts = await db
                .select()
                .from(schema.cart)
                .where(
                    and(
                        eq(schema.cart.customerId, customerId),
                        eq(schema.cart.status, "open"),
                    ),
                );

            expect(carts).toHaveLength(0);

            await expect(
                placeOrderFromItems(
                    db,
                    {
                        customerId,
                        items: [
                            {
                                productId: "gibt-es-nicht",
                                cycle: "monthly",
                                currency: "EUR",
                                quantity: 1,
                                options: [],
                            },
                        ],
                        paymentOption: "bank_transfer",
                        autoCharge: false,
                        acceptance: ACCEPTED,
                    },
                    ACTOR,
                    { now: AT, settings: SETTINGS },
                ),
            ).rejects.toThrow(/nicht bestellbar/);

            // The refused call rolled its cart back with everything else.
            expect(await db.select().from(schema.cart)).toHaveLength(1);
        });
    });
});
