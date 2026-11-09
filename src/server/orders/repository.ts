import "server-only";
import { and, asc, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { db, type db as defaultDb, schema } from "@/db";
import type {
    Order,
    OrderItem,
    Service,
    Subscription,
    SubscriptionItem,
} from "@/db/schema";
import { type Actor, audit } from "@/server/audit";
import { ANY_CUSTOMER } from "@/server/documents/repository";
import { OrderError } from "@/server/orders/service";

/**
 * Reading and deciding orders.
 *
 * Every loader takes the viewer's customer id and an admin flag and puts the
 * ownership rule into the query itself (rule 5), so a page that forgets to
 * check still cannot widen what comes back. A row the caller may not see
 * comes back `null` and the caller answers 404 — never 403, which would
 * confirm the id exists.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export { ANY_CUSTOMER };

export const DEFAULT_PAGE_SIZE = 25;

export type OrderListFilter = {
    status?: Order["status"];
    cursor?: string;
    limit?: number;
    /** Order number or customer name. */
    q?: string;
};

export async function listOrders(
    customerId: string,
    isAdmin: boolean,
    filter: OrderListFilter = {},
    executor: Executor = db,
) {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE_SIZE, 1), 100);

    const conditions = [
        isAdmin ? undefined : eq(schema.order.customerId, customerId),
        filter.status ? eq(schema.order.status, filter.status) : undefined,
        filter.cursor ? gt(schema.order.id, filter.cursor) : undefined,
        filter.q
            ? or(
                  ilike(schema.order.number, `%${filter.q}%`),
                  ilike(schema.customer.name, `%${filter.q}%`),
              )
            : undefined,
    ].filter((entry) => entry !== undefined);

    const rows = await executor
        .select({
            id: schema.order.id,
            number: schema.order.number,
            status: schema.order.status,
            currency: schema.order.currency,
            grossCents: schema.order.grossCents,
            netCents: schema.order.netCents,
            placedAt: schema.order.placedAt,
            customerId: schema.order.customerId,
            customerName: schema.customer.name,
            customerNumber: schema.customer.customerNumber,
            invoiceId: schema.order.invoiceId,
            paymentOption: schema.order.paymentOption,
        })
        .from(schema.order)
        .innerJoin(
            schema.customer,
            eq(schema.customer.id, schema.order.customerId),
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        // ULIDs sort by creation, so the id is the cursor (rule 1).
        .orderBy(filter.cursor ? asc(schema.order.id) : desc(schema.order.id))
        .limit(limit + 1);

    const page = rows.slice(0, limit);

    return {
        rows: page,
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > limit,
    };
}

export type LoadedOrder = {
    order: Order;
    items: OrderItem[];
    subscriptions: {
        subscription: Subscription;
        items: SubscriptionItem[];
    }[];
    services: Service[];
    invoice: {
        id: string;
        number: string | null;
        status: string;
        grossCents: number | null;
        dueAt: Date | null;
        paidAt: Date | null;
    } | null;
    customer: { id: string; name: string; customerNumber: number } | null;
};

export async function loadOrder(
    id: string,
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
): Promise<LoadedOrder | null> {
    const [order] = await executor
        .select()
        .from(schema.order)
        .where(
            isAdmin
                ? eq(schema.order.id, id)
                : and(
                      eq(schema.order.id, id),
                      eq(schema.order.customerId, customerId),
                  ),
        )
        .limit(1);

    if (!order) {
        return null;
    }

    const items = await executor
        .select()
        .from(schema.orderItem)
        .where(eq(schema.orderItem.orderId, order.id))
        .orderBy(asc(schema.orderItem.position));

    const subscriptions = await executor
        .select()
        .from(schema.subscription)
        .where(eq(schema.subscription.orderId, order.id))
        .orderBy(asc(schema.subscription.id));

    const subscriptionItems =
        subscriptions.length === 0
            ? []
            : await executor
                  .select()
                  .from(schema.subscriptionItem)
                  .where(
                      inArray(
                          schema.subscriptionItem.subscriptionId,
                          subscriptions.map((row) => row.id),
                      ),
                  )
                  .orderBy(asc(schema.subscriptionItem.position));

    const services =
        subscriptionItems.length === 0
            ? []
            : await executor
                  .select()
                  .from(schema.service)
                  .where(
                      inArray(
                          schema.service.subscriptionItemId,
                          subscriptionItems.map((row) => row.id),
                      ),
                  )
                  .orderBy(asc(schema.service.id));

    const [invoice] = order.invoiceId
        ? await executor
              .select({
                  id: schema.invoice.id,
                  number: schema.invoice.number,
                  status: schema.invoice.status,
                  grossCents: schema.invoice.grossCents,
                  dueAt: schema.invoice.dueAt,
                  paidAt: schema.invoice.paidAt,
              })
              .from(schema.invoice)
              .where(eq(schema.invoice.id, order.invoiceId))
        : [];

    const [customer] = await executor
        .select({
            id: schema.customer.id,
            name: schema.customer.name,
            customerNumber: schema.customer.customerNumber,
        })
        .from(schema.customer)
        .where(eq(schema.customer.id, order.customerId));

    return {
        order,
        items,
        subscriptions: subscriptions.map((subscription) => ({
            subscription,
            items: subscriptionItems.filter(
                (row) => row.subscriptionId === subscription.id,
            ),
        })),
        services,
        invoice: invoice ?? null,
        customer: customer ?? null,
    };
}

/** The subscriptions an order created, with their items — for a decision. */
async function subscriptionIdsOf(tx: Tx, orderId: string): Promise<string[]> {
    const rows = await tx
        .select({ id: schema.subscription.id })
        .from(schema.subscription)
        .where(eq(schema.subscription.orderId, orderId));

    return rows.map((row) => row.id);
}

async function lockOrder(tx: Tx, orderId: string): Promise<Order> {
    const [row] = await tx
        .select()
        .from(schema.order)
        .where(eq(schema.order.id, orderId))
        .for("update");

    if (!row) {
        throw new OrderError(
            "order-not-found",
            "Diese Bestellung gibt es nicht.",
        );
    }

    return row;
}

export type OrderDecision = "accept" | "cancel" | "fraud";

/** What an order that has already been decided is called, in words. */
const DECIDED_LABEL: Record<Order["status"], string> = {
    pending: "offen",
    active: "angenommen",
    cancelled: "storniert",
    fraud: "als Betrug markiert",
};

/**
 * Accept, cancel or refuse an order.
 *
 * Accepting is the gate the services wait behind: until a person (or, from
 * Phase 5, a settled payment) says yes, the subscriptions run but nothing is
 * handed out. Cancelling and marking fraud both stop the subscriptions —
 * marking fraud additionally terminates the services, because a fraudulent
 * order must not leave a machine standing that somebody could still reach.
 *
 * Deliberately *not* done here: cancelling the first invoice. A finalized
 * invoice is cancelled by a Rechnungskorrektur and nothing else (rule 3), so
 * the admin is told to issue one rather than having one issued silently
 * under a button that says "stornieren".
 */
export async function decideOrder(
    db: Db,
    orderId: string,
    decision: OrderDecision,
    actor: Actor,
    options: { reason?: string | null; now?: Date } = {},
): Promise<Order> {
    const at = options.now ?? new Date();

    return db.transaction(async (tx) => {
        const before = await lockOrder(tx, orderId);

        if (before.status !== "pending") {
            throw new OrderError(
                "decided",
                `Diese Bestellung wurde bereits ${DECIDED_LABEL[before.status]}.`,
            );
        }

        const status =
            decision === "accept"
                ? ("active" as const)
                : decision === "fraud"
                  ? ("fraud" as const)
                  : ("cancelled" as const);

        const [row] = await tx
            .update(schema.order)
            .set({
                status,
                acceptedAt: decision === "accept" ? at : null,
                cancelledAt: decision === "accept" ? null : at,
                decisionReason: options.reason?.trim() || null,
                updatedAt: at,
            })
            .where(eq(schema.order.id, orderId))
            .returning();

        const subscriptionIds = await subscriptionIdsOf(tx, orderId);

        if (subscriptionIds.length > 0 && decision !== "accept") {
            await tx
                .update(schema.subscription)
                .set({
                    status: "cancelled",
                    cancelledAt: at,
                    endedAt: at,
                    nextBillingAt: null,
                    updatedAt: at,
                })
                .where(inArray(schema.subscription.id, subscriptionIds));

            const items = await tx
                .select({ id: schema.subscriptionItem.id })
                .from(schema.subscriptionItem)
                .where(
                    inArray(
                        schema.subscriptionItem.subscriptionId,
                        subscriptionIds,
                    ),
                );

            if (items.length > 0) {
                const retired = await tx
                    .update(schema.service)
                    .set({
                        status: "terminated",
                        terminatedAt: at,
                        updatedAt: at,
                    })
                    .where(
                        and(
                            inArray(
                                schema.service.subscriptionItemId,
                                items.map((item) => item.id),
                            ),
                            /**
                             * Phase 8: only the rows that actually moved get
                             * a teardown, which is also what keeps a second
                             * „als Betrug markieren“ from asking for a
                             * second one.
                             */
                            sql`${schema.service.status} <> 'terminated'`,
                        ),
                    )
                    .returning({ id: schema.service.id });

                if (retired.length > 0) {
                    const { onServicesFollowed } = await import(
                        "@/server/provisioning/hooks"
                    );

                    await onServicesFollowed(tx, {
                        serviceIds: retired.map((row) => row.id),
                        follow: "terminated",
                        /**
                         * The order's own decision, which happens once: the
                         * status moved out of `pending` in this same
                         * transaction, so a second attempt finds nothing to
                         * decide.
                         */
                        cause: `order:${orderId}:${decision}`,
                    });
                }
            }
        }

        await audit(tx, {
            actor,
            action: `order.${decision}`,
            entityType: "order",
            entityId: orderId,
            before: { status: before.status },
            after: {
                status,
                reason: options.reason?.trim() || null,
                subscriptions: subscriptionIds.length,
            },
        });

        return row;
    });
}
