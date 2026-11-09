import "server-only";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { Service, ServiceStatus } from "@/db/schema";
import { type Actor, audit } from "@/server/audit";
import { getModule } from "./index";
import { addressesForService } from "./ip-pools";
import { readServiceCredentials } from "./runner";
import { tasksForService } from "./tasks";
import type { AssignedAddress, ClientAction } from "./types";

/**
 * Reading services, for the client area, the admin area and `/api/v1`.
 *
 * Every function here takes the customer it is reading *for* and scopes by
 * it. `ANY_CUSTOMER` is the staff sentinel, and it is a distinct value
 * rather than `null` so that forgetting to pass one is a type error instead
 * of an unscoped query — the arrangement `src/server/subscriptions/
 * repository.ts` already uses, and for the same reason: hard rule 5 says
 * nothing else gets to decide which rows a caller may touch.
 *
 * A caller who may not see a row gets `null`, which every caller turns into
 * a 404. Never a 403: that would confirm the id exists.
 */

type Db = typeof defaultDb;

export const ANY_CUSTOMER = Symbol("any-customer");
export type CustomerScope = string | typeof ANY_CUSTOMER;

export type ServiceListRow = {
    id: string;
    label: string;
    status: ServiceStatus;
    module: string;
    moduleLabel: string;
    customerId: string;
    productId: string;
    subscriptionId: string | null;
    hostname: string | null;
    providerStatus: string | null;
    providerStatusAt: Date | null;
    primaryAddress: string | null;
    activatedAt: Date | null;
    suspendedAt: Date | null;
    terminatedAt: Date | null;
};

export type LoadedService = {
    service: Service;
    moduleLabel: string;
    /** What the customer may press, from the module. Empty for `none`. */
    clientActions: readonly ClientAction[];
    addresses: AssignedAddress[];
    subscriptionId: string | null;
    subscriptionStatus: string | null;
    serverName: string | null;
    /** The provider's own id, where there is one. Staff only on the wire. */
    externalId: string | null;
    tasks: (typeof schema.provisioningTask.$inferSelect)[];
    /**
     * Whether the provider's last reading and `service.status` disagree.
     *
     * **Shown, never acted on.** See `runner.ts`: a machine stopped by hand
     * in the Proxmox UI under an active Abo is exactly this, and writing the
     * reading back into `service.status` would have the panel and the
     * operator taking turns starting and stopping it.
     */
    mismatch: string | null;
};

function scope(customer: CustomerScope) {
    return customer === ANY_CUSTOMER
        ? undefined
        : eq(schema.service.customerId, customer);
}

/**
 * The plain-German sentence for a service whose machine is not doing what
 * the billing record says it should.
 *
 * Deliberately a *description* and not a verdict. `pending` and
 * `provisioning` are excluded because there is nothing to disagree with yet,
 * and `terminated` because a machine that is gone is the point.
 */
export function describeMismatch(service: {
    status: ServiceStatus;
    providerStatus: string | null;
}): string | null {
    if (!service.providerStatus) {
        return null;
    }

    if (service.status === "active") {
        if (service.providerStatus === "missing") {
            return "Die Leistung ist aktiv, aber auf dem Server ist keine Maschine zu finden.";
        }

        if (
            service.providerStatus === "stopped" ||
            service.providerStatus === "suspended"
        ) {
            return "Die Leistung ist aktiv, die Maschine läuft aber nicht.";
        }
    }

    if (
        service.status === "suspended" &&
        service.providerStatus === "running"
    ) {
        return "Die Leistung ist gesperrt, die Maschine läuft aber.";
    }

    if (
        service.status === "terminated" &&
        service.providerStatus !== "missing"
    ) {
        return "Die Leistung ist abgebaut, auf dem Server existiert aber noch eine Maschine.";
    }

    return null;
}

export async function listServices(
    db: Pick<Db, "select">,
    customer: CustomerScope,
    options: {
        status?: readonly ServiceStatus[];
        cursor?: string | null;
        limit?: number;
        /** Terminated ones are history and are hidden unless asked for. */
        includeTerminated?: boolean;
    } = {},
): Promise<ServiceListRow[]> {
    const where = [
        scope(customer),
        options.status && options.status.length > 0
            ? inArray(schema.service.status, [...options.status])
            : options.includeTerminated
              ? undefined
              : sql`${schema.service.status} <> 'terminated'`,
        options.cursor ? gt(schema.service.id, options.cursor) : undefined,
    ].filter((value) => value !== undefined);

    const rows = await db
        .select({
            service: schema.service,
            subscriptionId: schema.subscriptionItem.subscriptionId,
        })
        .from(schema.service)
        .leftJoin(
            schema.subscriptionItem,
            eq(schema.service.subscriptionItemId, schema.subscriptionItem.id),
        )
        .where(where.length > 0 ? and(...where) : undefined)
        .orderBy(asc(schema.service.id))
        .limit(Math.min(options.limit ?? 50, 200));

    if (rows.length === 0) {
        return [];
    }

    /**
     * One query for every address rather than one per service. The list is
     * capped at 200, so this is a single `in (…)` and not an n+1 that only
     * shows up once somebody has a hundred machines.
     */
    const addresses = await db
        .select({
            serviceId: schema.ipAddress.serviceId,
            address: schema.ipAddress.address,
            family: schema.ipPool.family,
            id: schema.ipAddress.id,
        })
        .from(schema.ipAddress)
        .innerJoin(schema.ipPool, eq(schema.ipAddress.poolId, schema.ipPool.id))
        .where(
            inArray(
                schema.ipAddress.serviceId,
                rows.map((row) => row.service.id),
            ),
        )
        .orderBy(asc(schema.ipPool.family), asc(schema.ipAddress.id));

    const primary = new Map<string, string>();

    for (const address of addresses) {
        if (address.serviceId && !primary.has(address.serviceId)) {
            primary.set(address.serviceId, address.address);
        }
    }

    return rows.map((row) => ({
        id: row.service.id,
        label: row.service.label,
        status: row.service.status,
        module: row.service.module,
        moduleLabel: getModule(row.service.module)?.label ?? row.service.module,
        customerId: row.service.customerId,
        productId: row.service.productId,
        subscriptionId: row.subscriptionId ?? null,
        hostname: row.service.hostname,
        providerStatus: row.service.providerStatus,
        providerStatusAt: row.service.providerStatusAt,
        primaryAddress: primary.get(row.service.id) ?? null,
        activatedAt: row.service.activatedAt,
        suspendedAt: row.service.suspendedAt,
        terminatedAt: row.service.terminatedAt,
    }));
}

export async function loadService(
    db: Pick<Db, "select">,
    id: string,
    customer: CustomerScope,
): Promise<LoadedService | null> {
    const where = [eq(schema.service.id, id), scope(customer)].filter(
        (value) => value !== undefined,
    );

    const [row] = await db
        .select({
            service: schema.service,
            subscriptionId: schema.subscriptionItem.subscriptionId,
            subscriptionStatus: schema.subscription.status,
            serverName: schema.provisioningServer.name,
            externalId: schema.provisioningResource.externalId,
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
        .leftJoin(
            schema.provisioningServer,
            eq(schema.service.serverId, schema.provisioningServer.id),
        )
        .leftJoin(
            schema.provisioningResource,
            eq(schema.provisioningResource.serviceId, schema.service.id),
        )
        .where(and(...where))
        .limit(1);

    if (!row) {
        return null;
    }

    const module = getModule(row.service.module);

    return {
        service: row.service,
        moduleLabel: module?.label ?? row.service.module,
        clientActions: module?.clientActions ?? [],
        addresses: await addressesForService(db, id),
        subscriptionId: row.subscriptionId ?? null,
        subscriptionStatus: row.subscriptionStatus ?? null,
        serverName: row.serverName ?? null,
        externalId: row.externalId ?? null,
        tasks: await tasksForService(db, id),
        mismatch: describeMismatch(row.service),
    };
}

/**
 * The credential reveal, audited.
 *
 * Hard rule 8 asks for every state change to be logged; a reveal is not a
 * state change, and it is logged anyway — it is the one operation in the
 * panel where reading *is* the sensitive act. The entry names who looked and
 * at which service, and it does **not** contain the password: an audit log
 * that quoted the secret would be a second copy of it in a table far more
 * people can read than the one it came from.
 *
 * Returns null rather than throwing for a service the caller may not see, so
 * the caller answers 404 (never 403).
 */
export async function revealCredentials(
    db: Db,
    id: string,
    customer: CustomerScope,
    actor: Actor,
    origin: { ip?: string | null; userAgent?: string | null } = {},
): Promise<Record<string, string> | null> {
    const where = [eq(schema.service.id, id), scope(customer)].filter(
        (value) => value !== undefined,
    );

    const [service] = await db
        .select()
        .from(schema.service)
        .where(and(...where))
        .limit(1);

    if (!service) {
        return null;
    }

    const credentials = readServiceCredentials(service);

    await audit(db, {
        actor,
        action: "service.credentials.reveal",
        entityType: "service",
        entityId: id,
        after: {
            label: service.label,
            /** Which fields were handed over, never their values. */
            fields: credentials ? Object.keys(credentials).sort() : [],
        },
        ip: origin.ip ?? null,
        userAgent: origin.userAgent ?? null,
    });

    return credentials;
}

/** For the admin list: how many tasks are waiting or have given up. */
export async function queueSummary(db: Pick<Db, "select">): Promise<{
    pending: number;
    running: number;
    failed: number;
    aborted: number;
}> {
    const [row] = await db
        .select({
            pending: sql<number>`count(*) filter (where ${schema.provisioningTask.status} = 'pending')::int`,
            running: sql<number>`count(*) filter (where ${schema.provisioningTask.status} = 'running')::int`,
            failed: sql<number>`count(*) filter (where ${schema.provisioningTask.status} = 'failed')::int`,
            aborted: sql<number>`count(*) filter (where ${schema.provisioningTask.status} = 'aborted')::int`,
        })
        .from(schema.provisioningTask);

    return {
        pending: row?.pending ?? 0,
        running: row?.running ?? 0,
        failed: row?.failed ?? 0,
        aborted: row?.aborted ?? 0,
    };
}

/** The most recent tasks across every service, for the admin queue page. */
export async function recentTasks(db: Pick<Db, "select">, limit = 50) {
    return db
        .select({
            task: schema.provisioningTask,
            serviceLabel: schema.service.label,
            customerId: schema.service.customerId,
        })
        .from(schema.provisioningTask)
        .innerJoin(
            schema.service,
            eq(schema.provisioningTask.serviceId, schema.service.id),
        )
        .orderBy(desc(schema.provisioningTask.createdAt))
        .limit(limit);
}
