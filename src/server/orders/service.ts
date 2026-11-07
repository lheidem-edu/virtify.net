import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { BillingCycle, CartItem, Customer, Product } from "@/db/schema";
import { add, multiply } from "@/lib/money";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import {
    createInvoiceDraftIn,
    finalizeInvoiceIn,
    type InvoiceItemInput,
    resolveFinalizeOptions,
} from "@/server/billing/invoices/service";
import { firstPeriod } from "@/server/billing/periods";
import type { Quote, QuoteSelection } from "@/server/billing/pricing";
import { CODE_NOT_APPLICABLE, type QuoteContext } from "@/server/billing/quote";
import {
    addCartItem,
    closeCart,
    countCartItems,
    createCart,
    loadCartItems,
    lockCart,
} from "@/server/cart/repository";
import { priceCartItem } from "@/server/cart/view";
import { loadSellableProduct } from "@/server/catalog/lookup";
import { nextNumber } from "@/server/documents/numbering";
import { currentLegalVersion } from "@/server/legal/repository";
import {
    buildInvoiceLines,
    remainingDiscountPeriods,
} from "@/server/orders/lines";
import { getModule } from "@/server/provisioning";
import { loadSettings, type Settings } from "@/server/settings";

/**
 * The checkout: one cart, one transaction, and everything a sale consists of
 * written together or not at all.
 *
 *   order + order_item
 *     → one subscription per billing rhythm, with its price snapshot
 *       → a service in `pending` for everything that gets provisioned
 *     → the first invoice, finalized
 *
 * Three rules shape it, and a reviewer should check them first:
 *
 * 1. **Nothing the browser sent is a price.** Every figure is recomputed
 *    here, inside the transaction, by `quoteProductDetail` — the same call
 *    the product page and the quote endpoint make. The cart contributes a
 *    configuration and nothing else, so a tampered form can order a
 *    different product but can never order it at a different price.
 * 2. **The invoice is built by the invoicing engine, not beside it.**
 *    `createInvoiceDraftIn` and `finalizeInvoiceIn` are Phase 3's own code
 *    with the transaction handed in, so the tax strategy is resolved by the
 *    finalization date, the snapshot is frozen and the gapless number is
 *    taken under the counter's row lock exactly as it is everywhere else.
 *    There is no second finalization path.
 * 3. **A cart is checked out once.** The cart row is taken `FOR UPDATE`
 *    before anything is read from it, so two submissions of the same form
 *    serialise and the second one finds a cart that is no longer open.
 *    Coupons are redeemed with a conditional UPDATE for the same reason.
 *
 * The PDF is rendered after the commit, deliberately — see
 * `finalizeInvoiceIn`.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type OrderErrorCode =
    | "order-not-found"
    | "cart-not-found"
    | "cart-closed"
    | "cart-foreign"
    | "cart-empty"
    | "cart-changed"
    | "item"
    | "coupon"
    | "customer"
    | "decided"
    | "terms"
    | "currency";

export class OrderError extends Error {
    constructor(
        readonly code: OrderErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "OrderError";
    }
}

/** What the customer ticked and chose at the checkout. */
export type OrderAcceptance = {
    /**
     * The label of the AGB fassung the checkout printed under the tick box.
     * Null from a caller that never showed one — `/api/v1/orders`, where the
     * key's owner is agreeing on their own account.
     */
    termsLabel?: string | null;
    /** AGB. Required of everybody. */
    terms: boolean;
    /** Widerrufsbelehrung. Required of a Verbraucher, meaningless to a Firma. */
    withdrawal: boolean;
    /** § 356 Abs. 4 BGB — start before the fourteen days are up. */
    immediateStart: boolean;
};

export type PlaceOrderInput = {
    cartId: string;
    customerId: string;
    paymentOption: "bank_transfer" | "stripe" | "paypal";
    /** Collect the recurring charges automatically — Phase 5 acts on it. */
    autoCharge: boolean;
    acceptance: OrderAcceptance;
    note?: string | null;
    ip?: string | null;
    userAgent?: string | null;
};

export type PlaceOrderOptions = {
    now?: Date;
    settings?: Settings;
};

export type PlacedOrder = {
    orderId: string;
    number: string;
    invoiceId: string | null;
    invoiceNumber: string | null;
    netCents: number;
    taxCents: number;
    grossCents: number;
    subscriptionIds: string[];
    serviceIds: string[];
};

/**
 * Whether ordering this product creates something to be set up.
 *
 * A `subscription` product is Phase 2's "pure recurring product with nothing
 * to provision" and gets no service row. Everything else does — a VPS, a
 * webspace, a game server and a domain are all things a customer expects to
 * be handed, whether a module or a person hands them over. Once a real
 * module is registered in Phase 8 its own `provisions` flag decides as well,
 * so a product moved onto it cannot end up without a service to act on.
 */
export function provisionsService(product: Product): boolean {
    return (
        product.type !== "subscription" ||
        getModule(product.module)?.provisions === true
    );
}

/**
 * Items are grouped into subscriptions by their billing rhythm: the cycle
 * they renew on, the currency they are billed in, the free days before the
 * first charge, and the coupon that runs alongside them.
 *
 * The build plan asks for "one subscription per billing cycle", and with no
 * coupons and no trial that is exactly what this produces. The other two
 * parts of the key are there because they are also rhythm: a subscription
 * has one `trial_ends_at` and one discount counter, so two items whose free
 * days or whose coupon differ cannot share one without one of them being
 * billed on the other's schedule.
 */
function rhythmKey(entry: PricedEntry): string {
    return [
        entry.quote.totals.cycle,
        entry.quote.totals.currency,
        entry.quote.totals.trialDays,
        entry.quote.coupon?.id ?? "",
    ].join("|");
}

type PricedEntry = {
    item: CartItem;
    product: Product;
    quote: Quote;
    selections: QuoteSelection[];
};

/**
 * Redeems a coupon, or refuses to.
 *
 * The limit is enforced by the UPDATE itself rather than by a read followed
 * by a write: two checkouts racing for the last redemption of a code both
 * pass a `SELECT … WHERE redemptions < max`, and only one of them can come
 * back from this with a row.
 */
async function redeemCoupon(tx: Tx, couponId: string, code: string) {
    const updated = await tx
        .update(schema.coupon)
        .set({
            redemptions: sql`${schema.coupon.redemptions} + 1`,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(schema.coupon.id, couponId),
                eq(schema.coupon.active, true),
                or(
                    isNull(schema.coupon.maxRedemptions),
                    sql`${schema.coupon.redemptions} < ${schema.coupon.maxRedemptions}`,
                ),
            ),
        )
        .returning({ id: schema.coupon.id });

    if (updated.length === 0) {
        throw new OrderError(
            "coupon",
            `Der Gutscheincode „${code}“ ist nicht mehr verfügbar.`,
        );
    }
}

export async function placeOrder(
    db: Db,
    input: PlaceOrderInput,
    actor: Actor,
    options: PlaceOrderOptions = {},
): Promise<PlacedOrder> {
    const at = options.now ?? new Date();
    const settings = options.settings ?? (await loadSettings());
    // Resolved before the transaction opens, so no query that is not part of
    // the sale is made while the number counter's lock is held.
    const finalizeOptions = await resolveFinalizeOptions({ now: at, settings });

    const placed = await db.transaction(async (tx) =>
        placeOrderIn(tx, input, actor, { at, settings, finalizeOptions }),
    );

    return placed;
}

async function placeOrderIn(
    tx: Tx,
    input: PlaceOrderInput,
    actor: Actor,
    context: {
        at: Date;
        settings: Settings;
        finalizeOptions: Awaited<ReturnType<typeof resolveFinalizeOptions>>;
    },
): Promise<PlacedOrder> {
    const { at, settings } = context;

    // Everything else in this function reads from the cart, so the lock goes
    // first: a second submission of the same form blocks here and then finds
    // a cart that is no longer open.
    const cart = await lockCart(tx, input.cartId);

    if (!cart) {
        throw new OrderError("cart-not-found", "Dieser Warenkorb ist weg.");
    }

    if (cart.status !== "open") {
        throw new OrderError(
            "cart-closed",
            "Dieser Warenkorb wurde bereits bestellt.",
        );
    }

    if (cart.customerId !== null && cart.customerId !== input.customerId) {
        throw new OrderError(
            "cart-foreign",
            "Dieser Warenkorb gehört zu einem anderen Konto.",
        );
    }

    const customer = await loadOrderingCustomer(tx, input.customerId);
    const items = await loadCartItems(tx, cart.id);

    if (items.length === 0) {
        throw new OrderError("cart-empty", "Der Warenkorb ist leer.");
    }

    // The same billing anchor the cart and the checkout quoted with, so the
    // invoice charges the figure the customer confirmed.
    const entries = await priceEntries(tx, items, {
        now: at,
        anchorDay: settings.policy.billingAnchorDay,
    });

    for (const entry of entries) {
        if (entry.quote.totals.currency !== customer.currency) {
            throw new OrderError(
                "currency",
                `„${entry.product.name}“ wird nicht in ${customer.currency} abgerechnet.`,
            );
        }
    }

    const terms = await currentLegalVersion(tx, "terms");
    const isConsumer = customer.kind === "private";

    assertAcceptance(input.acceptance, isConsumer);

    /**
     * The fassung the buyer actually read, not the one that is current now.
     *
     * The checkout resolves the AGB while it renders and prints the label
     * under the tick box; publishing a new version takes effect the moment
     * its date arrives. Looking it up again here and storing *that* would
     * record the customer as having accepted terms they were never shown —
     * on an order that is the evidence of the contract. If it has moved
     * between the page and the button, the order stops and the customer
     * sees the new wording before agreeing to it.
     */
    if (
        input.acceptance.termsLabel &&
        input.acceptance.termsLabel !== terms.label
    ) {
        throw new OrderError(
            "terms",
            "Die Allgemeinen Geschäftsbedingungen wurden inzwischen geändert. Bitte lesen und bestätigen Sie die neue Fassung.",
        );
    }

    /**
     * A code that was typed into the cart but is not on the quote stops the
     * order rather than being dropped.
     *
     * The cart and the checkout both reprice on every render, so the
     * customer normally sees the code fall away before they submit. What is
     * left is the race: the last redemption taken between the page being
     * read and the button being pressed. Charging the undiscounted price
     * there would be the panel quietly taking more than the screen said.
     */
    for (const entry of entries) {
        if (entry.item.couponCode && !entry.quote.coupon) {
            throw new OrderError(
                "coupon",
                entry.quote.couponError ?? CODE_NOT_APPLICABLE,
            );
        }
    }

    // One redemption per code per order, however many lines carry it: the
    // order is what redeemed it.
    const coupons = new Map<string, string>();

    for (const entry of entries) {
        if (entry.quote.coupon) {
            coupons.set(entry.quote.coupon.id, entry.quote.coupon.code);
        }
    }

    for (const [couponId, code] of coupons) {
        await redeemCoupon(tx, couponId, code);
    }

    const orderId = createId("order");
    const number = await nextNumber(tx, "order", at);

    await tx.insert(schema.order).values({
        id: orderId,
        customerId: customer.id,
        number,
        status: "pending",
        currency: customer.currency,
        paymentOption: input.paymentOption,
        autoCharge: input.autoCharge,
        termsDocumentId: terms.documentId,
        termsVersion: terms.version,
        termsLabel: terms.label,
        termsAcceptedAt: at,
        withdrawalAcceptedAt: isConsumer ? at : null,
        immediateStartRequestedAt: isConsumer ? at : null,
        isConsumer,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        placedAt: at,
        note: input.note?.trim() || null,
    });

    const orderItemIds: string[] = [];

    for (const [index, entry] of entries.entries()) {
        const id = createId("orderitem");

        orderItemIds.push(id);

        await tx.insert(schema.orderItem).values({
            id,
            orderId,
            productId: entry.product.id,
            position: index + 1,
            description: entry.quote.productName,
            cycle: entry.quote.totals.cycle,
            currency: entry.quote.totals.currency,
            quantity: entry.item.quantity,
            unitPriceCents: unitPriceOf(entry),
            setupFeeCents: setupFeeOf(entry),
            trialDays: entry.quote.totals.trialDays,
            recurringGrossCents: entry.quote.totals.recurringGrossCents,
            recurringDiscountCents: entry.quote.totals.recurringDiscountCents,
            firstPeriodCents: entry.quote.totals.firstPeriodCents,
            renewalCents: entry.quote.totals.renewalCents,
            setupGrossCents: entry.quote.totals.setupGrossCents,
            setupDiscountCents: entry.quote.totals.setupDiscountCents,
            setupCents: entry.quote.totals.setupCents,
            // Filled in below, once the period is known and the lines built.
            dueTodayCents: 0,
            couponId: entry.quote.coupon?.id ?? null,
            couponCode: entry.quote.coupon?.code ?? null,
            discountPeriods: entry.quote.totals.discountPeriods,
            selections: entry.selections,
            lines: entry.quote.lines,
        });
    }

    // --- subscriptions, services and the first invoice's lines ------------

    const groups = new Map<string, number[]>();

    for (const [index, entry] of entries.entries()) {
        const key = rhythmKey(entry);
        const bucket = groups.get(key);

        if (bucket) {
            bucket.push(index);
        } else {
            groups.set(key, [index]);
        }
    }

    const subscriptionIds: string[] = [];
    const serviceIds: string[] = [];
    const invoiceLines: InvoiceItemInput[] = [];
    const dueByItem = new Map<number, number>();

    for (const indexes of groups.values()) {
        const lead = entries[indexes[0]];
        const cycle = lead.quote.totals.cycle;
        const trialDays = lead.quote.totals.trialDays;
        const trialing = trialDays > 0;

        /**
         * Billing starts when the free days are over — and the instant the
         * quote itself named, not one computed again here, so the date the
         * customer was shown in the cart is the date on the subscription.
         */
        const billingStart =
            trialing && lead.quote.totals.firstChargeAt
                ? lead.quote.totals.firstChargeAt
                : at;

        const period = firstPeriod({
            start: billingStart,
            cycle,
            anchorDay: settings.policy.billingAnchorDay,
        });

        const subscriptionId = createId("subscription");

        subscriptionIds.push(subscriptionId);

        await tx.insert(schema.subscription).values({
            id: subscriptionId,
            customerId: customer.id,
            orderId,
            status: trialing ? "trialing" : "active",
            cycle,
            currency: lead.quote.totals.currency,
            /**
             * The current period is the one the customer is in *now*, and
             * `next_billing_at` is when the next invoice falls due — which
             * for a trial is the day the free days end, not a whole cycle
             * after that.
             *
             * Writing `billingStart + one cycle` here skipped the first paid
             * period entirely: nothing had invoiced it (the checkout drops
             * every recurring line while trialing) and nothing would, because
             * the renewal run reads this column. The order page also told the
             * customer "nächste Abrechnung" a year after the cart had
             * promised the first charge right after the trial.
             */
            currentPeriodStart: at,
            currentPeriodEnd: trialing ? billingStart : period.end,
            nextBillingAt: trialing ? billingStart : period.end,
            trialEndsAt: trialing ? billingStart : null,
            autoCharge: input.autoCharge,
            couponId: lead.quote.coupon?.id ?? null,
            couponCode: lead.quote.coupon?.code ?? null,
            discountPeriodsRemaining: remainingDiscountPeriods(
                lead.quote.totals.discountPeriods,
                !trialing,
            ),
            startedAt: at,
        });

        for (const [offset, index] of indexes.entries()) {
            const entry = entries[index];
            const subscriptionItemId = createId("subscriptionitem");

            await tx.insert(schema.subscriptionItem).values({
                id: subscriptionItemId,
                subscriptionId,
                productId: entry.product.id,
                orderItemId: orderItemIds[index],
                position: offset + 1,
                description: entry.quote.productName,
                quantity: entry.item.quantity,
                unitPriceCents: unitPriceOf(entry),
                setupFeeCents: setupFeeOf(entry),
                recurringGrossCents: entry.quote.totals.recurringGrossCents,
                selections: entry.selections,
            });

            if (provisionsService(entry.product)) {
                // One per ordered unit: three VPS are three machines, and a
                // module that is handed one row for three of them has
                // nowhere to put the second one's address.
                for (let unit = 1; unit <= entry.item.quantity; unit += 1) {
                    const serviceId = createId("service");

                    serviceIds.push(serviceId);

                    await tx.insert(schema.service).values({
                        id: serviceId,
                        customerId: customer.id,
                        subscriptionItemId,
                        productId: entry.product.id,
                        status: "pending",
                        label:
                            entry.item.quantity > 1
                                ? `${entry.quote.productName} (${unit}/${entry.item.quantity})`
                                : entry.quote.productName,
                        module: entry.product.module,
                        provisioningMode: entry.product.provisioningMode,
                    });
                }
            }

            const built = buildInvoiceLines(entry.quote, period, { trialing });

            dueByItem.set(index, add(...built.map((line) => line.netCents)));

            for (const line of built) {
                invoiceLines.push({
                    description: line.description,
                    detail: line.detail,
                    quantity: line.quantity,
                    unitCode: line.unitCode,
                    unitPriceCents: line.unitPriceCents,
                    servicePeriodStart: line.servicePeriodStart,
                    servicePeriodEnd: line.servicePeriodEnd,
                });
            }
        }
    }

    for (const [index, id] of orderItemIds.entries()) {
        await tx
            .update(schema.orderItem)
            .set({ dueTodayCents: dueByItem.get(index) ?? 0 })
            .where(eq(schema.orderItem.id, id));
    }

    // --- the first invoice -------------------------------------------------

    let invoiceId: string | null = null;
    let invoiceNumber: string | null = null;
    let netCents = 0;
    let taxCents = 0;
    let grossCents = 0;

    /**
     * An order whose whole first charge is zero — everything on trial, or
     * discounted to nothing — issues no invoice at all rather than a 0,00 €
     * document, which is what `src/db/schema/orders.ts` has always said it
     * does. Counting the lines was not the same test: a 100 % coupon leaves
     * a base line and a discount line that cancel, so two lines summing to
     * nothing burned a gapless number on a document demanding nothing.
     */
    const firstChargeCents = add(
        ...invoiceLines.map((line) =>
            multiply(line.unitPriceCents, line.quantity),
        ),
    );

    if (invoiceLines.length > 0 && firstChargeCents !== 0) {
        const draft = await createInvoiceDraftIn(
            tx,
            {
                customerId: customer.id,
                introText: `Zu Ihrer Bestellung ${number}.`,
                items: invoiceLines,
            },
            actor,
        );

        const finalized = await finalizeInvoiceIn(
            tx,
            draft.id,
            actor,
            context.finalizeOptions,
        );

        invoiceId = draft.id;
        invoiceNumber = finalized.number;
        netCents = finalized.totals.netCents;
        taxCents = finalized.totals.taxCents;
        grossCents = finalized.totals.grossCents;
    }

    await tx
        .update(schema.order)
        .set({
            invoiceId,
            netCents,
            taxCents,
            grossCents,
            updatedAt: at,
        })
        .where(eq(schema.order.id, orderId));

    /**
     * The lock is on the `cart` row, and Postgres does not extend it to
     * `cart_item`: a second tab can insert a line while this order is being
     * placed, and the insert commits happily. Closing the cart then strands
     * that line in a cart nothing ever looks at again — the customer is told
     * "liegt im Warenkorb", and their next basket is empty.
     *
     * Counting again under the lock catches it. Rolling the whole order back
     * is the right answer rather than ordering the extra line: the customer
     * confirmed a total that did not include it.
     */
    if ((await countCartItems(tx, cart.id)) !== items.length) {
        throw new OrderError(
            "cart-changed",
            "Der Warenkorb hat sich während der Bestellung geändert. Bitte prüfen Sie ihn und bestellen Sie erneut.",
        );
    }

    await closeCart(tx, cart.id, { status: "ordered", orderId });

    await audit(tx, {
        actor,
        action: "order.place",
        entityType: "order",
        entityId: orderId,
        after: {
            number,
            customerId: customer.id,
            status: "pending",
            positions: entries.length,
            paymentOption: input.paymentOption,
            autoCharge: input.autoCharge,
            termsVersion: terms.version,
            invoiceNumber,
            netCents,
            taxCents,
            grossCents,
            subscriptions: subscriptionIds.length,
            services: serviceIds.length,
        },
        ip: input.ip,
        userAgent: input.userAgent,
    });

    return {
        orderId,
        number,
        invoiceId,
        invoiceNumber,
        netCents,
        taxCents,
        grossCents,
        subscriptionIds,
        serviceIds,
    };
}

function assertAcceptance(acceptance: OrderAcceptance, isConsumer: boolean) {
    if (!acceptance.terms) {
        throw new OrderError(
            "terms",
            "Bitte bestätigen Sie die Allgemeinen Geschäftsbedingungen.",
        );
    }

    if (!isConsumer) {
        // § 312g i. V. m. § 13 BGB: a Firma has no Widerrufsrecht, so there
        // is nothing for it to confirm having read.
        return;
    }

    if (!acceptance.withdrawal) {
        throw new OrderError(
            "terms",
            "Bitte bestätigen Sie die Kenntnisnahme der Widerrufsbelehrung.",
        );
    }

    if (!acceptance.immediateStart) {
        throw new OrderError(
            "terms",
            "Für den sofortigen Beginn der Leistung ist Ihr ausdrückliches Verlangen erforderlich.",
        );
    }
}

async function loadOrderingCustomer(
    tx: Tx,
    customerId: string,
): Promise<Customer> {
    const [row] = await tx
        .select()
        .from(schema.customer)
        .where(
            and(
                eq(schema.customer.id, customerId),
                isNull(schema.customer.deletedAt),
            ),
        );

    if (!row) {
        throw new OrderError("customer", "Dieses Kundenkonto gibt es nicht.");
    }

    if (row.status !== "active") {
        throw new OrderError(
            "customer",
            "Über dieses Kundenkonto kann derzeit nicht bestellt werden.",
        );
    }

    if (!row.street || !row.postalCode || !row.city || !row.country) {
        // § 14 Abs. 4 Nr. 1 UStG wants the recipient's full address on the
        // invoice this checkout is about to issue, and an invoice is not a
        // place to discover that half of it is missing.
        throw new OrderError(
            "customer",
            "Bitte vervollständigen Sie Ihre Rechnungsanschrift.",
        );
    }

    return row;
}

/**
 * The base price for a whole period, as the catalog had it — from the
 * quote's own base line, so it is the figure that was quoted and not a
 * second lookup.
 *
 * Deliberately the *whole* period and not what is being charged today: this
 * is the subscription's price snapshot, and a first period cut short to
 * reach the billing anchor is short exactly once.
 */
function unitPriceOf(entry: PricedEntry): number {
    const base = entry.quote.lines.find((line) => line.kind === "base");

    return base?.periodUnitAmountCents ?? base?.unitAmountCents ?? 0;
}

function setupFeeOf(entry: PricedEntry): number {
    return add(
        ...entry.quote.lines
            .filter((line) => line.kind === "setup")
            .map((line) => line.amountCents),
    );
}

/**
 * Prices every item again, from the catalog, inside the transaction. An item
 * that cannot be priced stops the whole order: a checkout that silently drops
 * a line charges for something other than what was in the basket.
 */
async function priceEntries(
    tx: Tx,
    items: CartItem[],
    context: QuoteContext,
): Promise<PricedEntry[]> {
    const entries: PricedEntry[] = [];

    for (const item of items) {
        const priced = await priceCartItem(tx, item, context);

        if (!priced.quote || !priced.detail) {
            throw new OrderError(
                "item",
                priced.problem ??
                    "Eine Position im Warenkorb kann nicht bestellt werden.",
            );
        }

        entries.push({
            item,
            product: priced.detail.product,
            quote: priced.quote,
            selections: priced.selections,
        });
    }

    return entries;
}

/** One configured product, as an API caller supplies it. */
export type OrderItemRequest = {
    productId: string;
    cycle: BillingCycle;
    currency: string;
    quantity: number;
    options: { optionId: string; valueId: string; quantity: number }[];
    couponCode?: string | null;
};

/**
 * Placing an order without a cart in a browser — what `POST /api/v1/orders`
 * does.
 *
 * It still goes through a cart, created and filled inside the very same
 * transaction that then checks it out. That is not ceremony: it means the
 * API and the storefront take the identical path through `placeOrderIn`, so
 * there is one place where an order comes into being and one set of rules
 * about what that costs. A failure rolls the cart back with everything else,
 * so a refused API call leaves nothing behind in the customer's basket.
 */
export async function placeOrderFromItems(
    db: Db,
    input: Omit<PlaceOrderInput, "cartId"> & { items: OrderItemRequest[] },
    actor: Actor,
    options: PlaceOrderOptions = {},
): Promise<PlacedOrder> {
    if (input.items.length === 0) {
        throw new OrderError(
            "cart-empty",
            "Die Bestellung hat keine Position.",
        );
    }

    const at = options.now ?? new Date();
    const settings = options.settings ?? (await loadSettings());
    const finalizeOptions = await resolveFinalizeOptions({ now: at, settings });

    return db.transaction(async (tx) => {
        // Before the cart, because the cart carries the foreign key: an
        // unknown or soft-deleted account would otherwise surface as a
        // constraint violation out of `createCart` — a 500 with Next's own
        // body rather than the documented 422 problem+json, and the
        // service's own sentence about it would never be reached.
        await loadOrderingCustomer(tx, input.customerId);

        const { cart } = await createCart(tx, {
            customerId: input.customerId,
        });

        for (const item of input.items) {
            // Checked before the insert so an unknown or unsellable product
            // is a sentence rather than a foreign-key violation.
            const detail = await loadSellableProduct(tx, item.productId);

            if (!detail) {
                throw new OrderError(
                    "item",
                    `„${item.productId}“ ist nicht bestellbar.`,
                );
            }

            await addCartItem(tx, {
                cartId: cart.id,
                productId: detail.product.id,
                cycle: item.cycle,
                currency: item.currency,
                quantity: item.quantity,
                selections: item.options,
                couponCode: item.couponCode ?? null,
            });
        }

        return placeOrderIn(tx, { ...input, cartId: cart.id }, actor, {
            at,
            settings,
            finalizeOptions,
        });
    });
}
