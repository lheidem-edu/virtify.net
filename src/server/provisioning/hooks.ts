import "server-only";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { ProvisioningActionName, ServiceStatus } from "@/db/schema";
import { getModule } from "./index";
import { enqueueForServices, enqueueTask, syncWindow } from "./tasks";

/**
 * Where the lifecycle meets the machine.
 *
 * Phase 6 already moves `service.status` — suspended at the dunning rung,
 * terminated when an Abo ends, created and retired by a quantity change —
 * and `docs/PROGRESS.md` has carried "Services do not actually stop" as the
 * open item ever since. These are the five listeners that close it, and they
 * are all there is: nothing else in the codebase enqueues a module call off
 * the back of a billing decision.
 *
 * ## Why this cannot loop
 *
 * The thing that would loop is obvious once it is named: the hooks write
 * `service.status` and the module reads it, so a module that wrote a status
 * back would hook itself. Three things stop it, and each is worth checking
 * separately:
 *
 *  1. **`applyServiceFollow` only moves services whose status is in the set
 *     it is moving *from*.** Writing the same follow twice moves zero rows,
 *     so the hook — which fires on the rows that actually moved, not on the
 *     statuses they now have — enqueues nothing the second time.
 *  2. **A reading is never a status.** `getStatus` writes
 *     `service.provider_status`, which no hook listens to. See
 *     `runner.ts` for the flapping machine that would otherwise result.
 *  3. **`create` is keyed `"create"` for ever.** The sweep that looks for
 *     services needing one can run every minute against an installation of
 *     ten thousand services and enqueue nothing, because every one of them
 *     already has a succeeded row under that key.
 */

type Db = typeof defaultDb;
type Tx = Pick<Db, "select" | "update" | "insert" | "delete">;

/**
 * `suspended` → suspend it, `active` → wake it, `terminated` → tear it down.
 *
 * `null` is every transition that deliberately leaves the services alone —
 * `trialing`, `past_due`, `cancelled` — and it enqueues nothing, which is
 * the whole of why `past_due` leaves a machine running: the grace between
 * the due date and the suspension rung *is* what dunning is.
 */
const FOLLOW_ACTION: Partial<Record<ServiceStatus, ProvisioningActionName>> = {
    suspended: "suspend",
    active: "unsuspend",
    terminated: "terminate",
};

/**
 * The hook on `applyServiceFollow`.
 *
 * `cause` is the request key and it has to be **unique per occurrence**: the
 * caller passes the id of the status change that caused this — the
 * subscription event, the dunning action, the change row. An Abo suspended
 * twice over a year is two causes and two requests; the same transition
 * reached twice in one transaction is one cause and one request. See the
 * table in `tasks.ts`.
 */
export async function onServicesFollowed(
    tx: Tx,
    input: {
        serviceIds: readonly string[];
        follow: ServiceStatus;
        cause: string;
        requestedBy?: string | null;
    },
): Promise<number> {
    const action = FOLLOW_ACTION[input.follow];

    if (!action || input.serviceIds.length === 0) {
        return 0;
    }

    const results = await enqueueForServices(tx, input.serviceIds, {
        action,
        requestKey: `${action}:${input.cause}`,
        requestedBy: input.requestedBy ?? null,
    });

    return results.filter((result) => result.created).length;
}

/**
 * A plan change that has been put into force on the item.
 *
 * Only the services that are actually running: a `pending` one has not been
 * built yet and will be built from the *new* product's configuration anyway,
 * and a `terminated` one is history.
 */
export async function onPackageChanged(
    tx: Tx,
    input: {
        serviceIds: readonly string[];
        cause: string;
        requestedBy?: string | null;
    },
): Promise<number> {
    if (input.serviceIds.length === 0) {
        return 0;
    }

    const running = await tx
        .select({ id: schema.service.id })
        .from(schema.service)
        .where(
            and(
                inArray(schema.service.id, [...input.serviceIds]),
                inArray(schema.service.status, ["active", "suspended"]),
            ),
        );

    const results = await enqueueForServices(
        tx,
        running.map((row) => row.id),
        {
            action: "change_package",
            requestKey: `change:${input.cause}`,
            requestedBy: input.requestedBy ?? null,
        },
    );

    return results.filter((result) => result.created).length;
}

/**
 * "This service should exist now."
 *
 * Every source of that sentence — a settled first invoice, a trial that
 * started, the daily pass, an operator pressing „Jetzt einrichten“ — is the
 * **same request**, so they all share the key `"create"`. A service is
 * created once, for ever; the second caller finds the first's row and adds
 * nothing.
 */
export async function enqueueCreate(
    tx: Tx,
    serviceId: string,
    requestedBy?: string | null,
): Promise<boolean> {
    const result = await enqueueTask(tx, {
        serviceId,
        action: "create",
        requestKey: "create",
        requestedBy: requestedBy ?? null,
    });

    return result.created;
}

/**
 * Whether a service may be set up without a person looking at it.
 *
 * `provisioning_mode` is snapshotted onto the service at checkout (Phase 4),
 * so changing a product does not change how an order already placed is
 * treated. `manual` means the operator presses the button; nothing
 * automatic may.
 */
function mayAutoProvision(service: {
    module: string;
    provisioningMode: string;
}): boolean {
    return (
        service.provisioningMode === "auto_on_payment" &&
        Boolean(getModule(service.module)?.provisions)
    );
}

export type CreateSweepReport = {
    considered: number;
    enqueued: number;
};

/**
 * Every service that is waiting to be set up and may be.
 *
 * The conditions, each for its own reason:
 *
 *  - **`pending`.** `provisioning` means a task has it; anything else means
 *    it has been built, torn down or suspended.
 *  - **`auto_on_payment`.** The product said so at the time of the order.
 *  - **The Abo is `trialing` or `active`.** A trial has paid nothing and is
 *    *supposed* to get a machine; `past_due` has not paid for the period it
 *    is in, and `paused`, `cancelled` and `ended` are not asking for one.
 *    `cancelled` is deliberately excluded even though it is still running:
 *    a service that has not been built by the time the customer cancels is
 *    one nobody is waiting for.
 *  - **Nothing open on it.** `hasOpenInvoice` — `OPEN_INVOICE_STATUSES`, so
 *    a half-paid first invoice does not get a server (rule 3). A `trialing`
 *    Abo skips this, because there is nothing to have paid.
 *
 * Safe to run every minute: see the header on why `"create"` makes that a
 * query and no writes.
 */
export async function sweepPendingCreates(
    db: Db,
    options: { limit?: number; requestedBy?: string | null } = {},
): Promise<CreateSweepReport> {
    const { hasOpenInvoice } = await import("@/server/subscriptions/service");

    const candidates = await db
        .select({
            serviceId: schema.service.id,
            module: schema.service.module,
            provisioningMode: schema.service.provisioningMode,
            subscriptionId: schema.subscriptionItem.subscriptionId,
            subscriptionStatus: schema.subscription.status,
        })
        .from(schema.service)
        .leftJoin(
            schema.subscriptionItem,
            eq(schema.service.subscriptionItemId, schema.subscriptionItem.id),
        )
        .leftJoin(
            schema.subscription,
            eq(schema.subscriptionItem.subscriptionId, schema.subscription.id),
        )
        .where(
            and(
                eq(schema.service.status, "pending"),
                eq(schema.service.provisioningMode, "auto_on_payment"),
                or(
                    isNull(schema.subscription.id),
                    inArray(schema.subscription.status, ["trialing", "active"]),
                ),
            ),
        )
        .limit(options.limit ?? 100);

    const report: CreateSweepReport = {
        considered: candidates.length,
        enqueued: 0,
    };

    for (const candidate of candidates) {
        if (!mayAutoProvision(candidate)) {
            continue;
        }

        /**
         * The question and the enqueue commit together. A customer paying
         * the last open invoice at the same instant this runs would
         * otherwise be read before the payment and queued after it, or the
         * reverse — and the reverse is the one that matters: a service
         * queued against an invoice that is still open.
         *
         * A service with no subscription at all — a one-off the operator
         * made by hand — has nothing to ask about and is taken at its word.
         */
        const created = await db.transaction(async (tx) => {
            if (
                candidate.subscriptionId &&
                candidate.subscriptionStatus !== "trialing" &&
                (await hasOpenInvoice(tx, candidate.subscriptionId))
            ) {
                return false;
            }

            return enqueueCreate(tx, candidate.serviceId, options.requestedBy);
        });

        if (created) {
            report.enqueued += 1;
        }
    }

    return report;
}

/**
 * The hook on a settled payment.
 *
 * Called from `emitInvoicePaid` — the seam every settled payment passes
 * through, whatever collected it — so a customer who pays their first
 * invoice at midnight has a machine at one minute past rather than at three
 * the next morning. The daily pass checks again for anything this missed,
 * and the two agree because both end in `enqueueCreate` under the same key.
 *
 * It never throws. A webhook that answered 500 because a VM could not be
 * queued would be retried by the provider, and the payment is settled either
 * way.
 */
export async function provisionAfterSettlement(
    db: Db,
    invoiceId: string,
): Promise<number> {
    const subscriptions = await db
        .select({ id: schema.subscriptionInvoice.subscriptionId })
        .from(schema.subscriptionInvoice)
        .where(eq(schema.subscriptionInvoice.invoiceId, invoiceId));

    /**
     * The first invoice of an order is linked through the order, not through
     * `subscription_invoice` — Phase 4 writes it as part of the checkout —
     * so both routes are followed. A subscription found twice is one
     * subscription; `enqueueCreate`'s key makes the duplicate free.
     */
    const viaOrder = await db
        .select({ id: schema.subscription.id })
        .from(schema.order)
        .innerJoin(
            schema.subscription,
            eq(schema.subscription.orderId, schema.order.id),
        )
        .where(eq(schema.order.invoiceId, invoiceId));

    const ids = [
        ...new Set(
            [...subscriptions, ...viaOrder].map((row) => row.id as string),
        ),
    ];

    if (ids.length === 0) {
        return 0;
    }

    const services = await db
        .select({
            serviceId: schema.service.id,
            module: schema.service.module,
            provisioningMode: schema.service.provisioningMode,
            subscriptionId: schema.subscriptionItem.subscriptionId,
            subscriptionStatus: schema.subscription.status,
        })
        .from(schema.service)
        .innerJoin(
            schema.subscriptionItem,
            eq(schema.service.subscriptionItemId, schema.subscriptionItem.id),
        )
        .innerJoin(
            schema.subscription,
            eq(schema.subscriptionItem.subscriptionId, schema.subscription.id),
        )
        .where(
            and(
                inArray(schema.subscriptionItem.subscriptionId, ids),
                eq(schema.service.status, "pending"),
            ),
        );

    const { hasOpenInvoice } = await import("@/server/subscriptions/service");
    let enqueued = 0;

    for (const service of services) {
        if (!mayAutoProvision(service)) {
            continue;
        }

        const created = await db.transaction(async (tx) => {
            /**
             * The same question the sweep asks, and for the same reason:
             * this invoice being settled does not mean the Abo owes nothing.
             * A customer with two open invoices who pays one has not bought
             * themselves a server.
             */
            if (
                service.subscriptionStatus !== "trialing" &&
                (await hasOpenInvoice(tx, service.subscriptionId as string))
            ) {
                return false;
            }

            return enqueueCreate(tx, service.serviceId, "payment");
        });

        if (created) {
            enqueued += 1;
        }
    }

    return enqueued;
}

/**
 * A reading of every live service, once an hour.
 *
 * Keyed on the UTC hour so the sweep running every minute asks for one
 * reading per hour per service rather than sixty. It writes
 * `provider_status` and nothing else — see `runner.ts`.
 */
export async function enqueueStatusSync(
    db: Db,
    at: Date = new Date(),
    options: { limit?: number } = {},
): Promise<number> {
    const services = await db
        .select({
            id: schema.service.id,
            module: schema.service.module,
        })
        .from(schema.service)
        .innerJoin(
            schema.provisioningResource,
            eq(schema.provisioningResource.serviceId, schema.service.id),
        )
        .where(inArray(schema.service.status, ["active", "suspended"]))
        .limit(options.limit ?? 200);

    let enqueued = 0;

    for (const service of services) {
        if (!getModule(service.module)?.provisions) {
            continue;
        }

        const result = await db.transaction((tx) =>
            enqueueTask(tx, {
                serviceId: service.id,
                action: "sync",
                requestKey: `sync:${syncWindow(at)}`,
                requestedBy: "worker",
            }),
        );

        if (result.created) {
            enqueued += 1;
        }
    }

    return enqueued;
}
