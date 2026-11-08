import { eq } from "drizzle-orm";
import type { BillingCycle } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { placeOrderFromItems } from "@/server/orders/service";
import { defaultSettings, type Settings } from "@/server/settings";
import { schema, type TestDb } from "./database";

/**
 * The fixtures the Phase 6 proofs are built on: an account, a product, and a
 * real checkout through `placeOrderFromItems`.
 *
 * Deliberately a real checkout rather than hand-written subscription rows.
 * The recurring run reads what the checkout wrote — the period, the price
 * snapshot, the coupon counter, the `subscription_invoice` link — and a test
 * that invents those rows itself would pass against a checkout that had
 * stopped writing them.
 */

export const ACTOR = { type: "system" as const, label: "test" };

export const SETTINGS: Settings = {
    ...defaultSettings,
    operator: {
        ...defaultSettings.operator,
        country: "DE",
        taxNumber: "305/5721/1234",
    },
};

/** The same settings with a billing anchor, so periods line up on the 1st. */
export function anchored(day = 1): Settings {
    return {
        ...SETTINGS,
        policy: { ...SETTINGS.policy, billingAnchorDay: day },
    };
}

export function withBilling(over: Partial<Settings["billing"]>): Settings {
    return { ...SETTINGS, billing: { ...SETTINGS.billing, ...over } };
}

export async function makeCustomer(
    db: TestDb,
    customerNumber: number,
    over: Partial<typeof schema.customer.$inferInsert> = {},
): Promise<string> {
    const userId = createId("user");

    await db.insert(schema.user).values({
        id: userId,
        name: `Kunde ${customerNumber}`,
        email: `kunde${customerNumber}@example.test`,
        emailVerified: true,
    });

    const [row] = await db
        .insert(schema.customer)
        .values({
            name: `Kunde ${customerNumber}`,
            customerNumber,
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
        email: `kunde${customerNumber}@example.test`,
    });

    return row.id;
}

export async function makeGroup(db: TestDb, slug = "vps"): Promise<string> {
    const [row] = await db
        .insert(schema.productGroup)
        .values({ slug, name: "KVM-Instanzen" })
        .returning();

    return row.id;
}

export async function makeProduct(
    db: TestDb,
    input: {
        groupId: string;
        slug: string;
        name: string;
        cycle: BillingCycle;
        priceCents: number;
        setupFeeCents?: number;
        trialDays?: number;
        type?: "vps" | "subscription";
        maxQuantity?: number;
        renewalLeadDays?: number | null;
    },
): Promise<string> {
    const [row] = await db
        .insert(schema.product)
        .values({
            groupId: input.groupId,
            slug: input.slug,
            name: input.name,
            type: input.type ?? "vps",
            status: "active",
            maxQuantity: input.maxQuantity ?? 5,
            renewalLeadDays: input.renewalLeadDays ?? null,
        })
        .returning();

    await db.insert(schema.productPricing).values({
        productId: row.id,
        cycle: input.cycle,
        currency: "EUR",
        priceCents: input.priceCents,
        setupFeeCents: input.setupFeeCents ?? 0,
        trialDays: input.trialDays ?? 0,
    });

    return row.id;
}

/** A checkout, through the real `placeOrder` path. */
export async function order(
    db: TestDb,
    input: {
        customerId: string;
        items: {
            productId: string;
            cycle: BillingCycle;
            quantity?: number;
            couponCode?: string | null;
        }[];
        now: Date;
        settings?: Settings;
        autoCharge?: boolean;
    },
) {
    return placeOrderFromItems(
        db,
        {
            customerId: input.customerId,
            items: input.items.map((item) => ({
                productId: item.productId,
                cycle: item.cycle,
                currency: "EUR",
                quantity: item.quantity ?? 1,
                options: [],
                couponCode: item.couponCode ?? null,
            })),
            paymentOption: "bank_transfer",
            autoCharge: input.autoCharge ?? false,
            acceptance: { terms: true, withdrawal: true, immediateStart: true },
        },
        ACTOR,
        { now: input.now, settings: input.settings ?? SETTINGS },
    );
}

export async function subscriptionOf(db: TestDb, id: string) {
    const [row] = await db
        .select()
        .from(schema.subscription)
        .where(eq(schema.subscription.id, id));

    return row;
}

export async function itemsOf(db: TestDb, subscriptionId: string) {
    return db
        .select()
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.subscriptionId, subscriptionId));
}

export async function servicesOf(db: TestDb, subscriptionItemId: string) {
    return db
        .select()
        .from(schema.service)
        .where(eq(schema.service.subscriptionItemId, subscriptionItemId));
}

export async function invoiceOf(db: TestDb, id: string) {
    const [row] = await db
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.id, id));

    return row;
}

export async function invoicesFor(db: TestDb, customerId: string) {
    return db
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.customerId, customerId))
        .orderBy(schema.invoice.id);
}

export async function linksFor(db: TestDb, subscriptionId: string) {
    return db
        .select()
        .from(schema.subscriptionInvoice)
        .where(eq(schema.subscriptionInvoice.subscriptionId, subscriptionId))
        .orderBy(schema.subscriptionInvoice.id);
}

export async function eventsOf(db: TestDb, subscriptionId: string) {
    return db
        .select()
        .from(schema.subscriptionEvent)
        .where(eq(schema.subscriptionEvent.subscriptionId, subscriptionId))
        .orderBy(schema.subscriptionEvent.id);
}

/**
 * Hands every connection of the pool out and back before a concurrency
 * proof.
 *
 * Phase 5 shipped a "two deliveries at once" test that never ran its two
 * transactions concurrently: the pool handed the first branch its one warm
 * connection while the second was still opening one, so the race the test
 * claimed to prove had already been serialised by the pool. Warming it first
 * is what makes the two actually overlap.
 */
export async function warmPool(db: TestDb, count: number) {
    const held = await Promise.all(
        Array.from({ length: count }, () => db.$pool.connect()),
    );

    for (const client of held) {
        client.release();
    }
}

/**
 * Phase 7. A department with a mailbox behind it, and a contact address that
 * the inbound pipeline can match a sender against.
 */
export async function makeDepartment(
    db: TestDb,
    over: Partial<typeof schema.ticketDepartment.$inferInsert> = {},
): Promise<string> {
    const [row] = await db
        .insert(schema.ticketDepartment)
        .values({
            name: "Support",
            slug: `support-${Math.random().toString(36).slice(2, 8)}`,
            mailbox: "support@example.test",
            isDefault: true,
            active: true,
            ...over,
        })
        .returning();

    return row.id;
}

/** The address a customer's contact is reached at, for sender matching. */
export async function contactEmail(
    db: TestDb,
    customerId: string,
): Promise<string> {
    const [row] = await db
        .select({ email: schema.customerContact.email })
        .from(schema.customerContact)
        .where(eq(schema.customerContact.customerId, customerId))
        .limit(1);

    return row.email;
}
