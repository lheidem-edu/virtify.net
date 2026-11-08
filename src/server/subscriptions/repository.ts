import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, lt } from "drizzle-orm";
import { db, type db as defaultDb, schema } from "@/db";
import type {
    Service,
    Subscription,
    SubscriptionChange,
    SubscriptionEvent,
    SubscriptionItem,
    SubscriptionStatus,
} from "@/db/schema";
import { ANY_CUSTOMER } from "@/server/documents/repository";

/**
 * Reading Abos.
 *
 * Rule 5, the same way every other loader in this project does it: the
 * ownership rule is part of the **query**, not something the page remembers
 * to check, and a row the caller may not see comes back `null` so the caller
 * answers 404 rather than 403.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export { ANY_CUSTOMER };

export const DEFAULT_PAGE_SIZE = 25;

export type SubscriptionListFilter = {
    status?: SubscriptionStatus;
    customerId?: string;
    /** The last id of the previous page; the rows below it follow. */
    cursor?: string;
    limit?: number;
    /** Customer name, or the description of one of its positions. */
    q?: string;
};

export type SubscriptionListRow = {
    id: string;
    status: SubscriptionStatus;
    cycle: string;
    currency: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date | null;
    nextBillingAt: Date | null;
    trialEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
    autoCharge: boolean;
    customerId: string;
    customerName: string;
    customerNumber: number;
    /** Base plus add-ons for one period, summed over the positions. */
    periodGrossCents: number;
    label: string;
};

export async function listSubscriptions(
    customerId: string,
    isAdmin: boolean,
    filter: SubscriptionListFilter = {},
    executor: Executor = db,
): Promise<{
    rows: SubscriptionListRow[];
    nextCursor: string | null;
    hasMore: boolean;
}> {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE_SIZE, 1), 100);

    const conditions = [
        isAdmin ? undefined : eq(schema.subscription.customerId, customerId),
        isAdmin && filter.customerId
            ? eq(schema.subscription.customerId, filter.customerId)
            : undefined,
        filter.status
            ? eq(schema.subscription.status, filter.status)
            : undefined,
        filter.cursor ? lt(schema.subscription.id, filter.cursor) : undefined,
        filter.q ? ilike(schema.customer.name, `%${filter.q}%`) : undefined,
    ].filter((entry) => entry !== undefined);

    const rows = await executor
        .select({
            id: schema.subscription.id,
            status: schema.subscription.status,
            cycle: schema.subscription.cycle,
            currency: schema.subscription.currency,
            currentPeriodStart: schema.subscription.currentPeriodStart,
            currentPeriodEnd: schema.subscription.currentPeriodEnd,
            nextBillingAt: schema.subscription.nextBillingAt,
            trialEndsAt: schema.subscription.trialEndsAt,
            cancelAtPeriodEnd: schema.subscription.cancelAtPeriodEnd,
            autoCharge: schema.subscription.autoCharge,
            customerId: schema.subscription.customerId,
            customerName: schema.customer.name,
            customerNumber: schema.customer.customerNumber,
        })
        .from(schema.subscription)
        .innerJoin(
            schema.customer,
            eq(schema.customer.id, schema.subscription.customerId),
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        // ULIDs sort by creation, so the id is the cursor (rule 1) — and the
        // list reads newest first, so the walk runs `WHERE id < $cursor ORDER
        // BY id DESC` all the way down. Both halves have to point the same
        // way: ordering descending and then comparing `id > $cursor` hands
        // page two the rows of page one and never reaches the oldest Abo.
        .orderBy(desc(schema.subscription.id))
        .limit(limit + 1);

    const page = rows.slice(0, limit);

    // One query for every page's positions rather than one per row.
    const items =
        page.length === 0
            ? []
            : await executor
                  .select()
                  .from(schema.subscriptionItem)
                  .where(
                      inArray(
                          schema.subscriptionItem.subscriptionId,
                          page.map((row) => row.id),
                      ),
                  )
                  .orderBy(asc(schema.subscriptionItem.position));

    const bySubscription = new Map<string, SubscriptionItem[]>();

    for (const item of items) {
        const bucket = bySubscription.get(item.subscriptionId);

        if (bucket) {
            bucket.push(item);
        } else {
            bySubscription.set(item.subscriptionId, [item]);
        }
    }

    return {
        rows: page.map((row) => {
            const own = bySubscription.get(row.id) ?? [];

            return {
                ...row,
                periodGrossCents: own.reduce(
                    (total, item) => total + item.recurringGrossCents,
                    0,
                ),
                label:
                    own.length === 0
                        ? "—"
                        : own.length === 1
                          ? own[0].description
                          : `${own[0].description} + ${own.length - 1} weitere`,
            };
        }),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > limit,
    };
}

export type LoadedSubscription = {
    subscription: Subscription;
    items: (SubscriptionItem & { services: Service[] })[];
    customer: { id: string; name: string; customerNumber: number } | null;
    /** Every invoice ever raised against it, newest first. */
    invoices: {
        id: string;
        number: string | null;
        status: string;
        kind: string;
        grossCents: number | null;
        paidCents: number;
        dueAt: Date | null;
        issuedAt: Date | null;
        periodStart: Date;
        periodEnd: Date | null;
    }[];
    events: SubscriptionEvent[];
    pendingChanges: SubscriptionChange[];
    paymentMethod: { id: string; label: string } | null;
};

export async function loadSubscription(
    id: string,
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
): Promise<LoadedSubscription | null> {
    const [subscription] = await executor
        .select()
        .from(schema.subscription)
        .where(
            and(
                eq(schema.subscription.id, id),
                isAdmin
                    ? undefined
                    : eq(schema.subscription.customerId, customerId),
            ),
        );

    if (!subscription) {
        return null;
    }

    const items = await executor
        .select()
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.subscriptionId, subscription.id))
        .orderBy(asc(schema.subscriptionItem.position));

    const services =
        items.length === 0
            ? []
            : await executor
                  .select()
                  .from(schema.service)
                  .where(
                      inArray(
                          schema.service.subscriptionItemId,
                          items.map((item) => item.id),
                      ),
                  )
                  .orderBy(asc(schema.service.id));

    const [customer] = await executor
        .select({
            id: schema.customer.id,
            name: schema.customer.name,
            customerNumber: schema.customer.customerNumber,
        })
        .from(schema.customer)
        .where(eq(schema.customer.id, subscription.customerId));

    const invoices = await executor
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            status: schema.invoice.status,
            kind: schema.subscriptionInvoice.kind,
            grossCents: schema.invoice.grossCents,
            paidCents: schema.invoice.paidCents,
            dueAt: schema.invoice.dueAt,
            issuedAt: schema.invoice.issuedAt,
            periodStart: schema.subscriptionInvoice.periodStart,
            periodEnd: schema.subscriptionInvoice.periodEnd,
        })
        .from(schema.subscriptionInvoice)
        .innerJoin(
            schema.invoice,
            eq(schema.subscriptionInvoice.invoiceId, schema.invoice.id),
        )
        .where(eq(schema.subscriptionInvoice.subscriptionId, subscription.id))
        .orderBy(desc(schema.subscriptionInvoice.periodStart));

    const events = await executor
        .select()
        .from(schema.subscriptionEvent)
        .where(eq(schema.subscriptionEvent.subscriptionId, subscription.id))
        .orderBy(desc(schema.subscriptionEvent.id))
        .limit(100);

    const pendingChanges = await executor
        .select()
        .from(schema.subscriptionChange)
        .where(
            and(
                eq(schema.subscriptionChange.subscriptionId, subscription.id),
                eq(schema.subscriptionChange.status, "pending"),
            ),
        )
        .orderBy(asc(schema.subscriptionChange.id));

    let paymentMethod: { id: string; label: string } | null = null;

    if (subscription.paymentMethodId) {
        const [method] = await executor
            .select({
                id: schema.paymentMethod.id,
                label: schema.paymentMethod.label,
            })
            .from(schema.paymentMethod)
            .where(eq(schema.paymentMethod.id, subscription.paymentMethodId));

        paymentMethod = method ?? null;
    }

    const byItem = new Map<string, Service[]>();

    for (const service of services) {
        if (!service.subscriptionItemId) {
            continue;
        }

        const bucket = byItem.get(service.subscriptionItemId);

        if (bucket) {
            bucket.push(service);
        } else {
            byItem.set(service.subscriptionItemId, [service]);
        }
    }

    return {
        subscription,
        items: items.map((item) => ({
            ...item,
            services: byItem.get(item.id) ?? [],
        })),
        customer: customer ?? null,
        invoices,
        events,
        pendingChanges,
        paymentMethod,
    };
}

/** The live payment methods an account may point a subscription at. */
export async function methodChoices(
    customerId: string,
    executor: Executor = db,
) {
    return executor
        .select({
            id: schema.paymentMethod.id,
            label: schema.paymentMethod.label,
            isDefault: schema.paymentMethod.isDefault,
        })
        .from(schema.paymentMethod)
        .where(
            and(
                eq(schema.paymentMethod.customerId, customerId),
                // A method the customer has withdrawn is not a choice.
                isNull(schema.paymentMethod.revokedAt),
            ),
        )
        .orderBy(asc(schema.paymentMethod.createdAt));
}
