import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { IpFamily } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import {
    assertAddress,
    assertPrefixLength,
    isIpv4,
    isIpv6,
    ProvisioningInputError,
    toRdns,
} from "./proxmox/sanitize";
import type { AllocateRequest, AssignedAddress } from "./types";

/**
 * Addresses, and who has them.
 *
 * ## The rule, in both directions
 *
 * `create` takes addresses out of a pool and `terminate` puts them back, and
 * those are the only two things that move the column. Everything else about
 * the lifecycle — a suspension, a plan change, a reinstall — leaves the
 * assignment exactly where it is, because the machine is still there and
 * still answering on it. Phase 6's lesson was that the way back has to give
 * back exactly what the way out took; here the way out is one column and the
 * way back is the same column, which is as close as this gets to being
 * impossible to get wrong.
 *
 * The exception is written down where it is enforced (`runner.ts`): a create
 * that aborted **before the provider was ever asked** gives everything back,
 * because then nothing can exist. One that failed afterwards keeps it — a VM
 * may be sitting on the other side of a timeout, and handing its address to
 * the next customer is a worse failure than leaking one until somebody
 * looks.
 *
 * ## Why allocation is a conditional update
 *
 * Counting free addresses and then taking the n-th is two statements with a
 * gap in the middle, and the gap is where two create passes hand the same
 * address to two customers. So the pick is `FOR UPDATE SKIP LOCKED` and the
 * take is `WHERE service_id IS NULL`: two passes racing for the last address
 * in a pool produce one winner and one "Pool erschöpft".
 */

type Db = typeof defaultDb;
type Tx = Pick<Db, "select" | "update" | "insert" | "delete" | "execute">;

export class IpPoolError extends Error {}

export type PoolInput = {
    serverId?: string | null;
    name: string;
    family: IpFamily;
    cidr?: string | null;
    gateway?: string | null;
    prefixLength: number;
    nameservers?: string[];
    enabled?: boolean;
    note?: string | null;
};

export async function listPools(
    db: Pick<Db, "select">,
    options: { serverId?: string | null } = {},
) {
    return db
        .select()
        .from(schema.ipPool)
        .where(
            options.serverId === undefined
                ? undefined
                : options.serverId === null
                  ? isNull(schema.ipPool.serverId)
                  : eq(schema.ipPool.serverId, options.serverId),
        )
        .orderBy(asc(schema.ipPool.name));
}

export async function getPool(db: Pick<Db, "select">, id: string) {
    const [row] = await db
        .select()
        .from(schema.ipPool)
        .where(eq(schema.ipPool.id, id))
        .limit(1);

    return row ?? null;
}

export async function poolCounts(
    db: Pick<Db, "select">,
    poolId: string,
): Promise<{ total: number; free: number; reserved: number }> {
    const [row] = await db
        .select({
            total: sql<number>`count(*)::int`,
            free: sql<number>`count(*) filter (
                where ${schema.ipAddress.serviceId} is null
                  and ${schema.ipAddress.reserved} = false
            )::int`,
            reserved: sql<number>`count(*) filter (
                where ${schema.ipAddress.reserved} = true
            )::int`,
        })
        .from(schema.ipAddress)
        .where(eq(schema.ipAddress.poolId, poolId));

    return {
        total: row?.total ?? 0,
        free: row?.free ?? 0,
        reserved: row?.reserved ?? 0,
    };
}

export async function createPool(
    db: Db,
    input: PoolInput,
    actor: Actor,
): Promise<typeof schema.ipPool.$inferSelect> {
    assertPrefixLength(input.prefixLength, input.family);

    if (input.gateway) {
        assertAddress(input.gateway, input.family);
    }

    for (const entry of input.nameservers ?? []) {
        if (!isIpv4(entry) && !isIpv6(entry)) {
            throw new ProvisioningInputError(
                `„${entry}“ ist kein gültiger Nameserver.`,
            );
        }
    }

    const id = createId("ippool");

    return db.transaction(async (tx) => {
        const [row] = await tx
            .insert(schema.ipPool)
            .values({
                id,
                serverId: input.serverId ?? null,
                name: input.name.trim(),
                family: input.family,
                cidr: input.cidr?.trim() || null,
                gateway: input.gateway?.trim().toLowerCase() || null,
                prefixLength: input.prefixLength,
                nameservers: input.nameservers ?? [],
                enabled: input.enabled ?? true,
                note: input.note?.trim() || null,
            })
            .returning();

        await audit(tx, {
            actor,
            action: "provisioning.pool.create",
            entityType: "ip_pool",
            entityId: id,
            after: {
                name: row.name,
                family: row.family,
                prefixLength: row.prefixLength,
                serverId: row.serverId,
            },
        });

        return row;
    });
}

/**
 * Adds addresses to a pool.
 *
 * Takes them one by one or as a `first–last` run, because an operator with a
 * /29 is going to type six addresses and an operator with a /24 is not. A
 * duplicate is skipped rather than refused: re-pasting a list that overlaps
 * the one already in the pool is the normal way this is used, and the unique
 * index on `(pool_id, address)` is what makes the skip safe rather than a
 * second row for the same address.
 */
export async function addAddresses(
    db: Db,
    poolId: string,
    addresses: readonly string[],
    actor: Actor,
    options: { reserved?: boolean } = {},
): Promise<{ added: number; skipped: number }> {
    const pool = await getPool(db, poolId);

    if (!pool) {
        throw new IpPoolError("Diesen Pool gibt es nicht.");
    }

    const normalised = [
        ...new Set(
            addresses
                .map((value) => value.trim().toLowerCase())
                .filter((value) => value !== "")
                .map((value) => assertAddress(value, pool.family)),
        ),
    ];

    if (normalised.length === 0) {
        return { added: 0, skipped: 0 };
    }

    if (normalised.length > 4096) {
        throw new IpPoolError(
            "Mehr als 4096 Adressen auf einmal nimmt das Formular nicht.",
        );
    }

    return db.transaction(async (tx) => {
        const inserted = await tx
            .insert(schema.ipAddress)
            .values(
                normalised.map((address) => ({
                    id: createId("ipaddress"),
                    poolId,
                    address,
                    reserved: options.reserved ?? false,
                })),
            )
            .onConflictDoNothing({
                target: [schema.ipAddress.poolId, schema.ipAddress.address],
            })
            .returning({ id: schema.ipAddress.id });

        await audit(tx, {
            actor,
            action: "provisioning.pool.addresses",
            entityType: "ip_pool",
            entityId: poolId,
            after: {
                added: inserted.length,
                skipped: normalised.length - inserted.length,
                reserved: options.reserved ?? false,
            },
        });

        return {
            added: inserted.length,
            skipped: normalised.length - inserted.length,
        };
    });
}

/** Everything a module needs about an address it has been given. */
function toAssigned(
    address: typeof schema.ipAddress.$inferSelect,
    pool: typeof schema.ipPool.$inferSelect,
): AssignedAddress {
    return {
        id: address.id,
        poolId: pool.id,
        family: pool.family,
        address: address.address,
        prefixLength: pool.prefixLength,
        gateway: pool.gateway,
        nameservers: (pool.nameservers as string[] | null) ?? [],
        rdns: address.rdns,
    };
}

export async function addressesForService(
    db: Pick<Db, "select">,
    serviceId: string,
): Promise<AssignedAddress[]> {
    const rows = await db
        .select({ address: schema.ipAddress, pool: schema.ipPool })
        .from(schema.ipAddress)
        .innerJoin(schema.ipPool, eq(schema.ipAddress.poolId, schema.ipPool.id))
        .where(eq(schema.ipAddress.serviceId, serviceId))
        .orderBy(asc(schema.ipPool.family), asc(schema.ipAddress.id));

    return rows.map((row) => toAssigned(row.address, row.pool));
}

export class PoolExhaustedError extends Error {
    constructor(
        family: IpFamily,
        readonly poolId: string | null,
    ) {
        super(
            `Es ist keine freie ${
                family === "ipv4" ? "IPv4" : "IPv6"
            }-Adresse mehr verfügbar.`,
        );
        this.name = "PoolExhaustedError";
    }
}

/**
 * Tops a service up to `count` addresses of one family.
 *
 * **Tops up, rather than adds.** A create that is retried must not walk the
 * pool down one address per attempt, and the service's existing assignments
 * are the honest record of what it already has — so the function asks how
 * many it holds and takes only the difference. A service that already has
 * what it needs gets a read and no write at all.
 *
 * `count: 0` is a product that wants no address of that family, and it
 * neither takes nor releases: taking an address away from a running machine
 * because somebody edited a product is not this function's decision to make.
 */
export async function allocateAddresses(
    tx: Tx,
    input: AllocateRequest & { serviceId: string; serverId: string | null },
): Promise<AssignedAddress[]> {
    const held = (await addressesForService(tx, input.serviceId)).filter(
        (address) => address.family === input.family,
    );

    if (input.count <= 0 || held.length >= input.count) {
        return held;
    }

    const taken: AssignedAddress[] = [...held];

    for (let index = held.length; index < input.count; index += 1) {
        const row = await takeOne(tx, {
            family: input.family,
            poolId: input.poolId ?? null,
            serverId: input.serverId,
            serviceId: input.serviceId,
        });

        if (!row) {
            throw new PoolExhaustedError(input.family, input.poolId ?? null);
        }

        taken.push(row);
    }

    return taken;
}

/**
 * One address, claimed.
 *
 * The pick and the take are one statement on purpose. `FOR UPDATE SKIP
 * LOCKED` in the sub-select means a second pass does not block on the row
 * this one is taking, it takes the next; `service_id is null` in the outer
 * `WHERE` means that even without the lock — a replica, a different
 * isolation level, a future refactor — the address cannot be handed out
 * twice. Two guards for one invariant, because the invariant is "no two
 * machines answer on the same address" and it is the kind of thing a
 * customer discovers before we do.
 */
async function takeOne(
    tx: Tx,
    input: {
        family: IpFamily;
        poolId: string | null;
        serverId: string | null;
        serviceId: string;
    },
): Promise<AssignedAddress | null> {
    const now = new Date();

    const result = await tx.execute<{ id: string; pool_id: string }>(sql`
        update ${schema.ipAddress}
           set service_id = ${input.serviceId},
               assigned_at = ${now},
               updated_at = ${now}
         where id = (
               select a.id
                 from ${schema.ipAddress} a
                 join ${schema.ipPool} p on p.id = a.pool_id
                where a.service_id is null
                  and a.reserved = false
                  and p.enabled = true
                  and p.family = ${input.family}
                  ${input.poolId ? sql`and p.id = ${input.poolId}` : sql``}
                  /**
                   * The server scope holds even when a product names its
                   * pool. A pool belongs to one cluster's network; handing
                   * one of its addresses to a machine on another cluster
                   * produces a VM that is unreachable and an address that
                   * is booked as in use — and the product form is exactly
                   * where that mistake is made.
                   */
                  and (p.server_id is null or p.server_id = ${input.serverId})
                order by a.id
                limit 1
                for update of a skip locked
         )
           and service_id is null
     returning id, pool_id
    `);

    const row = result.rows[0];

    if (!row) {
        return null;
    }

    const [address] = await tx
        .select({ address: schema.ipAddress, pool: schema.ipPool })
        .from(schema.ipAddress)
        .innerJoin(schema.ipPool, eq(schema.ipAddress.poolId, schema.ipPool.id))
        .where(eq(schema.ipAddress.id, row.id))
        .limit(1);

    return address ? toAssigned(address.address, address.pool) : null;
}

/**
 * The other direction. Returns how many addresses went back.
 *
 * `rdns` is cleared with the assignment, because it names a host that is no
 * longer there — leaving it would hand the next customer a reverse record
 * pointing at the last one's domain, which is somebody else's name on
 * somebody else's address.
 */
export async function releaseAddresses(
    tx: Tx,
    serviceId: string,
): Promise<number> {
    const released = await tx
        .update(schema.ipAddress)
        .set({
            serviceId: null,
            assignedAt: null,
            rdns: null,
            updatedAt: new Date(),
        })
        .where(eq(schema.ipAddress.serviceId, serviceId))
        .returning({ id: schema.ipAddress.id });

    return released.length;
}

/**
 * Releases exactly the addresses a given attempt took, and nothing else.
 *
 * Used by the abort path, where "exactly what it took" is the whole point:
 * a service that already had an address from an earlier, successful create
 * must keep it. The ids are the ones the module was handed, so the set is
 * the attempt's own.
 */
export async function releaseAddressIds(
    tx: Tx,
    serviceId: string,
    ids: readonly string[],
): Promise<number> {
    if (ids.length === 0) {
        return 0;
    }

    const released = await tx
        .update(schema.ipAddress)
        .set({
            serviceId: null,
            assignedAt: null,
            rdns: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(schema.ipAddress.serviceId, serviceId),
                inArray(schema.ipAddress.id, [...ids]),
            ),
        )
        .returning({ id: schema.ipAddress.id });

    return released.length;
}

/** The operator's rDNS field. Only on an address that is actually assigned. */
export async function setRdns(
    db: Db,
    addressId: string,
    value: string,
    actor: Actor,
): Promise<string | null> {
    const rdns = toRdns(value);

    return db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(schema.ipAddress)
            .where(eq(schema.ipAddress.id, addressId))
            .limit(1);

        if (!before) {
            throw new IpPoolError("Diese Adresse gibt es nicht.");
        }

        if (!before.serviceId) {
            throw new IpPoolError(
                "Für eine nicht zugewiesene Adresse gibt es keinen PTR-Eintrag.",
            );
        }

        await tx
            .update(schema.ipAddress)
            .set({ rdns, updatedAt: new Date() })
            .where(eq(schema.ipAddress.id, addressId));

        await audit(tx, {
            actor,
            action: "provisioning.rdns.set",
            entityType: "ip_address",
            entityId: addressId,
            before: { rdns: before.rdns },
            after: { rdns, address: before.address },
        });

        return rdns;
    });
}

/** Addresses in a pool, for the admin list. */
export async function listAddresses(
    db: Pick<Db, "select">,
    poolId: string,
    options: { assignedOnly?: boolean } = {},
) {
    return db
        .select({
            address: schema.ipAddress,
            serviceLabel: schema.service.label,
            customerId: schema.service.customerId,
        })
        .from(schema.ipAddress)
        .leftJoin(
            schema.service,
            eq(schema.ipAddress.serviceId, schema.service.id),
        )
        .where(
            options.assignedOnly
                ? and(
                      eq(schema.ipAddress.poolId, poolId),
                      isNotNull(schema.ipAddress.serviceId),
                  )
                : eq(schema.ipAddress.poolId, poolId),
        )
        .orderBy(asc(schema.ipAddress.id))
        .limit(500);
}
