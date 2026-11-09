import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { createId } from "@/lib/ulid";
import { type Actor, audit, diff } from "@/server/audit";
import { getModule, ModuleConfigError, parseServerConfig } from "./index";
import type { ConnectionCheck } from "./types";

/**
 * The servers a module puts things on, and the one place their credentials
 * are opened.
 *
 * Hard rule 6: the API token is AES-256-GCM ciphertext bound to a context
 * string that names the row, so a `provisioning_server` copied into another
 * installation's database does not open and a backup is not a set of live
 * hypervisor credentials. The decrypted value never reaches an audit entry's
 * `before`/`after`, never a thrown message and never a log line — the tests
 * for that are in `tests/integration/provisioning.test.ts`.
 *
 * **There is no cluster for this installation and no credentials were gone
 * looking for.** A server with no token is a server `testConnection` reports
 * as unconfigured and that no task will run against.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const CONTEXT = (serverId: string) => `provisioning_server.${serverId}.token`;

export type ServerCredentials = Record<string, string>;

export type ServerInput = {
    module: string;
    name: string;
    hostname?: string | null;
    enabled?: boolean;
    config: unknown;
    /** Omitted on an update leaves whatever is stored in place. */
    credentials?: ServerCredentials | null;
    maxServices?: number | null;
    note?: string | null;
};

export class ProvisioningServerError extends Error {}

export async function listServers(
    db: Pick<Db, "select">,
    options: { module?: string; includeDeleted?: boolean } = {},
) {
    const where = [
        options.includeDeleted
            ? undefined
            : isNull(schema.provisioningServer.deletedAt),
        options.module
            ? eq(schema.provisioningServer.module, options.module)
            : undefined,
    ].filter((value) => value !== undefined);

    return db
        .select()
        .from(schema.provisioningServer)
        .where(where.length > 0 ? and(...where) : undefined)
        .orderBy(asc(schema.provisioningServer.name));
}

export async function getServer(
    db: Pick<Db, "select">,
    id: string,
): Promise<typeof schema.provisioningServer.$inferSelect | null> {
    const [row] = await db
        .select()
        .from(schema.provisioningServer)
        .where(eq(schema.provisioningServer.id, id))
        .limit(1);

    return row ?? null;
}

/**
 * How many services are placed on a server right now.
 *
 * Terminated ones do not count: the machine is gone and the row is history.
 * This is the panel's own book-keeping against `max_services`, which is a
 * different question from whether a node has free memory — the module asks
 * the cluster about that when it picks a node.
 */
export async function serverLoad(
    db: Pick<Db, "select">,
    serverId: string,
): Promise<number> {
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.service)
        .where(
            and(
                eq(schema.service.serverId, serverId),
                sql`${schema.service.status} <> 'terminated'`,
            ),
        );

    return row?.count ?? 0;
}

export async function createServer(
    db: Db,
    input: ServerInput,
    actor: Actor,
): Promise<typeof schema.provisioningServer.$inferSelect> {
    const module = getModule(input.module);

    if (!module) {
        throw new ProvisioningServerError(
            `Das Modul „${input.module}“ gibt es nicht.`,
        );
    }

    // Throws before the transaction opens if the module cannot read it.
    const config = parseServerConfig(input.module, input.config);
    const id = createId("server");

    return db.transaction(async (tx) => {
        const [row] = await tx
            .insert(schema.provisioningServer)
            .values({
                id,
                module: input.module,
                name: input.name.trim(),
                hostname: input.hostname?.trim() || null,
                enabled: input.enabled ?? true,
                config,
                credentialsEncrypted: input.credentials
                    ? encrypt(JSON.stringify(input.credentials), CONTEXT(id))
                    : null,
                maxServices: input.maxServices ?? null,
                note: input.note?.trim() || null,
            })
            .returning();

        await audit(tx, {
            actor,
            action: "provisioning.server.create",
            entityType: "provisioning_server",
            entityId: id,
            after: {
                module: input.module,
                name: row.name,
                // The config is the operator's, not a secret — but the token
                // is, and it is deliberately not in here at all.
                config,
                credentials: input.credentials ? "set" : "none",
            },
        });

        return row;
    });
}

export async function updateServer(
    db: Db,
    id: string,
    patch: Partial<ServerInput>,
    actor: Actor,
): Promise<typeof schema.provisioningServer.$inferSelect> {
    return db.transaction(async (tx) => {
        const before = await getServer(tx, id);

        if (!before || before.deletedAt) {
            throw new ProvisioningServerError("Diesen Server gibt es nicht.");
        }

        const moduleId = patch.module ?? before.module;
        const next: Record<string, unknown> = { updatedAt: new Date() };

        if (patch.name !== undefined) {
            next.name = patch.name.trim();
        }

        if (patch.hostname !== undefined) {
            next.hostname = patch.hostname?.trim() || null;
        }

        if (patch.enabled !== undefined) {
            next.enabled = patch.enabled;
        }

        if (patch.maxServices !== undefined) {
            next.maxServices = patch.maxServices;
        }

        if (patch.note !== undefined) {
            next.note = patch.note?.trim() || null;
        }

        /**
         * The configuration has to be read by whichever module the server
         * *will* belong to, not the one it belongs to now — the same rule the
         * product form follows.
         */
        if (patch.module !== undefined || patch.config !== undefined) {
            next.module = moduleId;
            next.config = parseServerConfig(
                moduleId,
                patch.config ?? (before.config as Record<string, unknown>),
            );
        }

        /**
         * `undefined` leaves the stored token alone, `null` clears it. The
         * difference matters: an operator saving the form without retyping
         * the secret must not wipe it, and an operator who wants it gone has
         * to be able to say so.
         */
        if (patch.credentials !== undefined) {
            next.credentialsEncrypted =
                patch.credentials === null
                    ? null
                    : encrypt(JSON.stringify(patch.credentials), CONTEXT(id));
        }

        const [row] = await tx
            .update(schema.provisioningServer)
            .set(next)
            .where(eq(schema.provisioningServer.id, id))
            .returning();

        const changed = diff(
            {
                module: before.module,
                name: before.name,
                hostname: before.hostname,
                enabled: before.enabled,
                maxServices: before.maxServices,
                config: JSON.stringify(before.config),
            },
            {
                module: row.module,
                name: row.name,
                hostname: row.hostname,
                enabled: row.enabled,
                maxServices: row.maxServices,
                config: JSON.stringify(row.config),
            },
        );

        await audit(tx, {
            actor,
            action: "provisioning.server.update",
            entityType: "provisioning_server",
            entityId: id,
            before: changed?.before ?? null,
            after: {
                ...(changed?.after ?? {}),
                ...(patch.credentials !== undefined
                    ? {
                          // Never the value. Only that it moved.
                          credentials:
                              patch.credentials === null ? "cleared" : "set",
                      }
                    : {}),
            },
        });

        return row;
    });
}

/**
 * Rule 10. A server a service points at is never hard-deleted: the row keeps
 * saying what the machine was on, and a `deleted_at` server is simply never
 * chosen for anything new.
 */
export async function deleteServer(
    db: Db,
    id: string,
    actor: Actor,
): Promise<void> {
    await db.transaction(async (tx) => {
        const before = await getServer(tx, id);

        if (!before) {
            throw new ProvisioningServerError("Diesen Server gibt es nicht.");
        }

        const load = await serverLoad(tx, id);

        if (load > 0) {
            throw new ProvisioningServerError(
                `Auf diesem Server liegen noch ${load} Leistungen. ` +
                    "Erst abbauen, dann entfernen.",
            );
        }

        await tx
            .update(schema.provisioningServer)
            .set({
                deletedAt: new Date(),
                enabled: false,
                updatedAt: new Date(),
            })
            .where(eq(schema.provisioningServer.id, id));

        await audit(tx, {
            actor,
            action: "provisioning.server.delete",
            entityType: "provisioning_server",
            entityId: id,
            before: { name: before.name, enabled: before.enabled },
            after: { deleted: true },
        });
    });
}

/**
 * The credentials, opened. The only function in the codebase that does it,
 * and it is `server-only`.
 *
 * A blob that will not open is a configuration fault and is reported as
 * "none" rather than letting a caller fall back to a *different* cluster's
 * token — the same decision `loadMailChannelConfig` makes.
 */
export function serverCredentials(
    row: Pick<
        typeof schema.provisioningServer.$inferSelect,
        "id" | "credentialsEncrypted"
    >,
): ServerCredentials | null {
    if (!row.credentialsEncrypted) {
        return null;
    }

    try {
        return JSON.parse(
            decrypt(row.credentialsEncrypted, CONTEXT(row.id)),
        ) as ServerCredentials;
    } catch (error) {
        console.error(
            `[provisioning] the stored token for ${row.id} could not be decrypted:`,
            error,
        );

        return null;
    }
}

/**
 * The server's configuration, parsed. Throws when the module cannot read it,
 * which is the right answer: a task must not run against a configuration
 * nobody validated.
 */
export function serverConfig(
    row: Pick<
        typeof schema.provisioningServer.$inferSelect,
        "module" | "config"
    >,
): Record<string, unknown> {
    return parseServerConfig(row.module, row.config);
}

/**
 * Picks the server a new service goes on.
 *
 * Panel-level, deliberately crude, and not the same question as which *node*
 * inside a cluster: that one is the module's and is answered against live
 * capacity (`proxmox/nodes.ts`). Here it is only "which of the operator's
 * clusters", by how full they are against `max_services`, so a second
 * cluster added for headroom actually gets used.
 */
export async function chooseServer(
    db: Pick<Db, "select">,
    moduleId: string,
): Promise<typeof schema.provisioningServer.$inferSelect | null> {
    const candidates = (await listServers(db, { module: moduleId })).filter(
        (row) => row.enabled && row.credentialsEncrypted,
    );

    if (candidates.length === 0) {
        return null;
    }

    let best: {
        row: (typeof candidates)[number];
        headroom: number;
    } | null = null;

    for (const row of candidates) {
        const load = await serverLoad(db, row.id);

        if (row.maxServices !== null && load >= row.maxServices) {
            continue;
        }

        /**
         * A server with no ceiling is `Infinity` free, which is right: the
         * operator said "as many as fit" and the module still refuses when
         * no node has memory. A ceiling that is set competes on how much of
         * it is left, so the emptier cluster wins.
         */
        const headroom =
            row.maxServices === null
                ? Number.POSITIVE_INFINITY
                : row.maxServices - load;

        if (!best || headroom > best.headroom) {
            best = { row, headroom };
        }
    }

    return best?.row ?? null;
}

/** Runs the module's own check and records what it said on the row. */
export async function testServerConnection(
    db: Db,
    id: string,
    actor: Actor,
    options: { fetchImpl?: typeof fetch } = {},
): Promise<ConnectionCheck> {
    const row = await getServer(db, id);

    if (!row) {
        throw new ProvisioningServerError("Diesen Server gibt es nicht.");
    }

    const module = getModule(row.module);

    if (!module?.testConnection) {
        throw new ProvisioningServerError(
            `Das Modul „${row.module}“ kennt keinen Verbindungstest.`,
        );
    }

    const credentials = serverCredentials(row);
    let check: ConnectionCheck;

    try {
        check = credentials
            ? await module.testConnection({
                  config: serverConfig(row),
                  credentials,
                  fetchImpl: options.fetchImpl,
              })
            : {
                  ok: false,
                  detail: "Für diesen Server ist kein API-Token hinterlegt.",
              };
    } catch (error) {
        check = {
            ok: false,
            detail:
                error instanceof ModuleConfigError
                    ? error.message
                    : error instanceof Error
                      ? error.message
                      : "Unbekannter Fehler.",
        };
    }

    await db.transaction(async (tx) => {
        await tx
            .update(schema.provisioningServer)
            .set({
                lastCheckAt: new Date(),
                lastCheckOk: check.ok,
                lastCheckDetail: check.detail.slice(0, 1000),
                updatedAt: new Date(),
            })
            .where(eq(schema.provisioningServer.id, id));

        await audit(tx, {
            actor,
            action: "provisioning.server.test",
            entityType: "provisioning_server",
            entityId: id,
            after: { ok: check.ok, detail: check.detail.slice(0, 500) },
        });
    });

    return check;
}

export type { Tx };
