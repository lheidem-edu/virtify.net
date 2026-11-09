import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type {
    ProvisioningActionName,
    ProvisioningResource,
    Service,
} from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { getModule, ModuleConfigError, parseModuleConfig } from "./index";
import {
    addressesForService,
    allocateAddresses,
    PoolExhaustedError,
    releaseAddresses,
    releaseAddressIds,
} from "./ip-pools";
import { ProxmoxError, ProxmoxUnreachableError } from "./proxmox/api";
import { NoCapacityError } from "./proxmox/nodes";
import { ProvisioningInputError } from "./proxmox/sanitize";
import {
    ProvisioningServerError,
    serverConfig,
    serverCredentials,
} from "./servers";
import { backoffSeconds, claimTask, runnableTasks } from "./tasks";
import type {
    AssignedAddress,
    ModuleContext,
    ModuleResult,
    ProviderStatus,
} from "./types";

/**
 * Running one module call, and writing back what happened.
 *
 * Everything in this phase that touches a real machine comes through
 * `runProvisioningTask`. One door, for the same three reasons
 * `transitionSubscriptionIn` is one:
 *
 *  1. The claim is taken here and nowhere else, so the worker's sweep, the
 *     operator's "jetzt ausführen" and `POST /api/v1/services/{id}/actions/…`
 *     cannot run the same request twice between them.
 *  2. **Giving things back lives here.** `terminate` releases the addresses
 *     and the reserved VMID; an attempt that aborted before the provider was
 *     asked releases exactly what *that attempt* took. Those are the only
 *     two places in the codebase that release anything, which is what makes
 *     "the way back gives back exactly what the way out took" a statement
 *     somebody can check rather than a hope.
 *  3. The audit entry rule 8 asks for is written beside the result, in the
 *     same transaction.
 *
 * ## Who wins when the provider disagrees with us
 *
 * **`service.status` always does.** A `sync` writes `provider_status`, a
 * different column that nothing acts on, and a `create` or a `terminate`
 * writes `service.status` because those are the module reporting on work we
 * asked for — which is not the same thing as a poll.
 *
 * If a reading were written back into `service.status`, this is what would
 * happen: an operator stops a VM by hand in the Proxmox UI, the next sync
 * writes `suspended`, `wakeSettledIn` sees a suspended service under an Abo
 * that owes nothing and wakes it, the wake enqueues `unsuspend`, the machine
 * starts, and the operator stops it again. A machine flapping between two
 * systems that each believe the other. So the disagreement is *shown* — the
 * client and admin pages say "läuft nicht, obwohl die Leistung aktiv ist" —
 * and it is a thing for a person, never an instruction.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const CREDENTIAL_CONTEXT = (serviceId: string) =>
    `service.${serviceId}.credentials`;

export type RunOptions = {
    actor?: Actor;
    at?: Date;
    /** Injected in tests. See `tests/helpers/proxmox.ts`. */
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
};

export type RunOutcome =
    | { ran: false; reason: string }
    | {
          ran: true;
          taskId: string;
          action: ProvisioningActionName;
          ok: boolean;
          summary: string;
          warnings: string[];
          alreadyDone: boolean;
          /** Set when the task gave up for good or aborted. */
          terminal?: boolean;
      };

/** The classes of failure that mean "nothing further will change by trying". */
function permanent(error: unknown): boolean {
    if (
        error instanceof ProvisioningInputError ||
        error instanceof ModuleConfigError ||
        error instanceof ProvisioningServerError
    ) {
        return true;
    }

    if (error instanceof ProxmoxError) {
        return !error.retryable;
    }

    return false;
}

/** The ones that are "not yet" rather than "never". */
function transient(error: unknown): boolean {
    if (error instanceof ProxmoxUnreachableError) {
        return true;
    }

    if (error instanceof ProxmoxError) {
        return error.retryable;
    }

    /**
     * A pool with nothing free and a cluster with no room are both states
     * that change on their own — somebody cancels, the operator adds a
     * range. They are reported as transient so the service is retried
     * rather than written off, and because they always happen before the
     * provider is asked they also abort, which hands the addresses back
     * while we wait.
     */
    return (
        error instanceof PoolExhaustedError || error instanceof NoCapacityError
    );
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * One task, claimed and run.
 *
 * Returns rather than throws: the caller is a sweep that has other tasks to
 * get to, or a server action that wants to show the operator what happened.
 * Everything that went wrong is on the task row and in the audit log.
 */
export async function runProvisioningTask(
    db: Db,
    taskId: string,
    options: RunOptions = {},
): Promise<RunOutcome> {
    const at = options.at ?? new Date();
    const actor: Actor = options.actor ?? { type: "system", label: "worker" };

    const task = await claimTask(db, taskId, at);

    if (!task) {
        // Somebody else has it, it is finished, or it is out of attempts.
        return { ran: false, reason: "not-claimable" };
    }

    const loaded = await load(db, task.serviceId);

    if (!loaded) {
        await finish(db, task.id, {
            status: "aborted",
            error: "Die Leistung gibt es nicht mehr.",
            at,
        });

        return { ran: false, reason: "service-gone" };
    }

    const module = getModule(loaded.service.module);

    if (!module?.provisions) {
        await finish(db, task.id, {
            status: "aborted",
            error: `Das Modul „${loaded.service.module}“ stellt nichts bereit.`,
            at,
        });

        return { ran: false, reason: "module-does-not-provision" };
    }

    const method = methodFor(module, task.action);

    if (!method) {
        await finish(db, task.id, {
            status: "aborted",
            error: `Das Modul „${module.id}“ kann „${task.action}“ nicht.`,
            at,
        });

        return { ran: false, reason: "action-unsupported" };
    }

    /**
     * A power action on a machine that is not in service.
     *
     * **This is the one guard that is about money rather than correctness.**
     * A customer whose server was suspended for an unpaid invoice must not
     * be able to press „Starten“ and have it back; without this, the whole
     * dunning ladder is a button away from being undone. The same holds for
     * a reinstall, which would rebuild a machine the panel has stopped
     * paying attention to.
     *
     * It is asked **before** anything else that could refuse — before the
     * server is even looked for — so that the reason the caller is given is
     * this one. An installation with no cluster configured yet would
     * otherwise answer „Kein Server hinterlegt“ to a customer trying to
     * start a machine we switched off for non-payment, which is the right
     * refusal for the wrong reason and tells whoever is debugging it to go
     * and configure a server.
     */
    if (
        (task.action === "power" || task.action === "reinstall") &&
        loaded.service.status !== "active"
    ) {
        await finish(db, task.id, {
            status: "aborted",
            error: `Die Leistung ist „${loaded.service.status}“ — dafür gibt es keine Aktionen.`,
            at,
        });

        return {
            ran: true,
            taskId: task.id,
            action: task.action,
            ok: false,
            summary: `Die Leistung ist „${loaded.service.status}“.`,
            warnings: [],
            alreadyDone: false,
            terminal: true,
        };
    }

    if (!loaded.server) {
        /**
         * No server, or none with a token. Transient by nature — the
         * operator is about to add one — so it aborts rather than failing:
         * nothing has been reserved, nothing is held, and the next sweep
         * asks again.
         */
        await abort(db, task.id, {
            error:
                "Für dieses Modul ist kein einsatzbereiter Server hinterlegt " +
                "(aktiv, mit API-Token).",
            allocated: [],
            serviceId: loaded.service.id,
            attempts: task.attempts,
            at,
        });

        return {
            ran: true,
            taskId: task.id,
            action: task.action,
            ok: false,
            summary: "Kein Server hinterlegt.",
            warnings: [],
            alreadyDone: false,
            terminal: true,
        };
    }

    /**
     * A create begins by saying so. Only from `pending`: a service that is
     * already `active` is one whose create succeeded, and relabelling it
     * `provisioning` would make the client page lie for as long as the task
     * ran.
     */
    if (task.action === "create" && loaded.service.status === "pending") {
        await db
            .update(schema.service)
            .set({ status: "provisioning", updatedAt: at })
            .where(
                and(
                    eq(schema.service.id, loaded.service.id),
                    eq(schema.service.status, "pending"),
                ),
            );
    }

    /** What *this attempt* took, for the abort path and nothing else. */
    const allocated: string[] = [];
    const logLines: string[] = [];
    let resource: ProvisioningResource | null = loaded.resource;
    let providerCalled = task.providerCalledAt !== null;
    let addresses = loaded.addresses;

    const ctx: ModuleContext = {
        service: loaded.service,
        config: loaded.config,
        server: {
            row: loaded.server.row,
            config: loaded.server.config,
            credentials: loaded.server.credentials,
        },
        get resource() {
            return resource;
        },
        get addresses() {
            return addresses;
        },
        payload: (task.payload as Record<string, unknown>) ?? {},
        now: at,
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,

        async markProviderCalled() {
            if (providerCalled) {
                return;
            }

            providerCalled = true;

            await db
                .update(schema.provisioningTask)
                .set({ providerCalledAt: at, updatedAt: at })
                .where(
                    and(
                        eq(schema.provisioningTask.id, task.id),
                        isNull(schema.provisioningTask.providerCalledAt),
                    ),
                );
        },

        async reserveResource(input) {
            if (resource) {
                return resource;
            }

            const existing = await readResource(db, loaded.service.id);

            if (existing) {
                resource = existing;

                return existing;
            }

            /**
             * The provider's id is drawn **before** the row is written, and
             * the row is what makes it ours. A unique violation here means
             * another pass drew the same id in the same instant — rare, and
             * the answer is to read back whoever won rather than to insert
             * a second row.
             */
            const externalId = await input.nextId();

            try {
                const [row] = await db
                    .insert(schema.provisioningResource)
                    .values({
                        id: createId("provres"),
                        serverId: loaded.server?.row.id as string,
                        serviceId: loaded.service.id,
                        kind: input.kind,
                        externalId,
                        node: input.node ?? null,
                    })
                    .returning();

                resource = row;
            } catch {
                const again = await readResource(db, loaded.service.id);

                if (!again) {
                    throw new ProvisioningServerError(
                        `Die Kennung ${externalId} ist bereits vergeben und ` +
                            "für diese Leistung ist keine hinterlegt.",
                    );
                }

                resource = again;
            }

            await db
                .update(schema.service)
                .set({ serverId: loaded.server?.row.id, updatedAt: at })
                .where(eq(schema.service.id, loaded.service.id));

            return resource as ProvisioningResource;
        },

        async confirmResource(node) {
            if (!resource) {
                return;
            }

            const [row] = await db
                .update(schema.provisioningResource)
                .set({
                    confirmedAt: resource.confirmedAt ?? at,
                    ...(node ? { node } : {}),
                    updatedAt: at,
                })
                .where(eq(schema.provisioningResource.id, resource.id))
                .returning();

            resource = row ?? resource;
        },

        async allocateAddresses(request) {
            const before = new Set(addresses.map((entry) => entry.id));
            const after = await allocateAddresses(db, {
                ...request,
                serviceId: loaded.service.id,
                serverId: loaded.server?.row.id ?? null,
            });

            for (const entry of after) {
                if (!before.has(entry.id)) {
                    allocated.push(entry.id);
                }
            }

            addresses = await addressesForService(db, loaded.service.id);

            return after;
        },

        async setCredentials(value) {
            await db
                .update(schema.service)
                .set({
                    credentialsEncrypted: encrypt(
                        JSON.stringify(value),
                        CREDENTIAL_CONTEXT(loaded.service.id),
                    ),
                    updatedAt: at,
                })
                .where(eq(schema.service.id, loaded.service.id));
        },

        async readCredentials() {
            return readServiceCredentials(loaded.service);
        },

        async patchModuleData(patch) {
            const merged = {
                ...((loaded.service.moduleData as Record<string, unknown>) ??
                    {}),
                ...patch,
            };

            loaded.service.moduleData = merged;

            await db
                .update(schema.service)
                .set({
                    moduleData: merged,
                    ...(typeof patch.hostname === "string"
                        ? { hostname: patch.hostname }
                        : {}),
                    updatedAt: at,
                })
                .where(eq(schema.service.id, loaded.service.id));
        },

        log(message) {
            logLines.push(message);
        },
    };

    try {
        if (task.action === "sync") {
            const status = (await (
                method as (c: ModuleContext) => Promise<ProviderStatus>
            )(ctx)) ?? { state: "unknown", detail: null };

            await writeProviderStatus(db, loaded.service.id, status, at);
            await finish(db, task.id, {
                status: "succeeded",
                at,
                result: { state: status.state, detail: status.detail },
                summary: status.detail ?? status.state,
            });

            return {
                ran: true,
                taskId: task.id,
                action: task.action,
                ok: true,
                summary: status.detail ?? status.state,
                warnings: [],
                alreadyDone: true,
            };
        }

        const result = await (
            method as (c: ModuleContext) => Promise<ModuleResult>
        )(ctx);

        await db.transaction(async (tx) => {
            await applyResult(tx, {
                task,
                service: loaded.service,
                result,
                at,
                released:
                    task.action === "terminate"
                        ? await release(tx, loaded.service.id)
                        : null,
            });

            await audit(tx, {
                actor,
                action: `provisioning.${task.action}`,
                entityType: "service",
                entityId: loaded.service.id,
                after: {
                    task: task.id,
                    summary: result.summary,
                    alreadyDone: result.alreadyDone ?? false,
                    warnings: result.warnings ?? [],
                    // Never the credentials, never the token.
                    data: result.data ?? {},
                },
            });
        });

        return {
            ran: true,
            taskId: task.id,
            action: task.action,
            ok: true,
            summary: result.summary,
            warnings: [...(result.warnings ?? []), ...logLines],
            alreadyDone: result.alreadyDone ?? false,
        };
    } catch (error) {
        const message = describe(error);

        /**
         * **The line between "nothing can exist" and "something might."**
         *
         * `provider_called_at` is still null, so no request that could have
         * changed anything ever left this process. Then and only then is it
         * honest to give back what this attempt took: the addresses it
         * allocated — not the ones the service already had — and, if it
         * reserved a VMID without using it, that too.
         *
         * Past that line nothing is released, however the attempt failed. A
         * clone whose answer never arrived may well have run, and handing
         * its address to the next customer is a far worse failure than
         * leaking one until a person looks.
         */
        if (!providerCalled) {
            await abort(db, task.id, {
                error: message,
                allocated,
                serviceId: loaded.service.id,
                attempts: task.attempts,
                at,
                /** Only one this attempt reserved and never used. */
                resourceId:
                    task.action === "create" &&
                    resource &&
                    !loaded.resource &&
                    !resource.confirmedAt
                        ? resource.id
                        : null,
            });

            await audit(db, {
                actor,
                action: `provisioning.${task.action}.abort`,
                entityType: "service",
                entityId: loaded.service.id,
                after: {
                    task: task.id,
                    error: message.slice(0, 500),
                    releasedAddresses: allocated.length,
                },
            });

            return {
                ran: true,
                taskId: task.id,
                action: task.action,
                ok: false,
                summary: message,
                warnings: logLines,
                alreadyDone: false,
                terminal: true,
            };
        }

        const retryable = !permanent(error) || transient(error);
        const attemptsLeft = task.attempts < task.maxAttempts;
        const terminal = !retryable || !attemptsLeft;

        await finish(db, task.id, {
            status: "failed",
            error: message,
            at,
            runAfter: terminal
                ? null
                : new Date(at.getTime() + backoffSeconds(task.attempts) * 1000),
            /**
             * A create that has given up leaves the service `pending` rather
             * than `provisioning`: nothing is working on it, and a label that
             * says otherwise is the panel lying to the operator who has to
             * fix it.
             */
            resetProvisioning:
                terminal &&
                task.action === "create" &&
                loaded.service.status === "provisioning",
            serviceId: loaded.service.id,
        });

        await audit(db, {
            actor,
            action: `provisioning.${task.action}.fail`,
            entityType: "service",
            entityId: loaded.service.id,
            after: {
                task: task.id,
                attempt: task.attempts,
                error: message.slice(0, 500),
                terminal,
            },
        });

        return {
            ran: true,
            taskId: task.id,
            action: task.action,
            ok: false,
            summary: message,
            warnings: logLines,
            alreadyDone: false,
            terminal,
        };
    }
}

type Loaded = {
    service: Service;
    config: Record<string, unknown>;
    resource: ProvisioningResource | null;
    addresses: AssignedAddress[];
    server: {
        row: typeof schema.provisioningServer.$inferSelect;
        config: Record<string, unknown>;
        credentials: Record<string, string>;
    } | null;
};

async function load(db: Db, serviceId: string): Promise<Loaded | null> {
    const [service] = await db
        .select()
        .from(schema.service)
        .where(eq(schema.service.id, serviceId))
        .limit(1);

    if (!service) {
        return null;
    }

    const [product] = await db
        .select({ moduleConfig: schema.product.moduleConfig })
        .from(schema.product)
        .where(eq(schema.product.id, service.productId))
        .limit(1);

    /**
     * The product's configuration, re-read every time. A plan change moves
     * `service.product_id`, so `changePackage` reading it here is what makes
     * "the new tariff's cores" one lookup rather than a snapshot somebody
     * has to remember to update.
     */
    const config = parseModuleConfig(
        service.module,
        product?.moduleConfig ?? {},
    );

    const resource = await readResource(db, serviceId);
    const addresses = await addressesForService(db, serviceId);

    /**
     * The server the service is already on, if it has one. A service that
     * has been placed never moves: its VM is on that cluster and nowhere
     * else, so re-choosing on a retry would look for a machine where it
     * cannot be.
     */
    const serverId = service.serverId ?? resource?.serverId ?? null;
    let row: typeof schema.provisioningServer.$inferSelect | undefined;

    if (serverId) {
        [row] = await db
            .select()
            .from(schema.provisioningServer)
            .where(eq(schema.provisioningServer.id, serverId))
            .limit(1);
    } else {
        const { chooseServer } = await import("./servers");
        const chosen = await chooseServer(db, service.module);

        row = chosen ?? undefined;
    }

    if (!row) {
        return { service, config, resource, addresses, server: null };
    }

    const credentials = serverCredentials(row);

    if (!credentials) {
        return { service, config, resource, addresses, server: null };
    }

    return {
        service,
        config,
        resource,
        addresses,
        server: { row, config: serverConfig(row), credentials },
    };
}

async function readResource(
    db: Pick<Db, "select">,
    serviceId: string,
): Promise<ProvisioningResource | null> {
    const [row] = await db
        .select()
        .from(schema.provisioningResource)
        .where(eq(schema.provisioningResource.serviceId, serviceId))
        .limit(1);

    return row ?? null;
}

function methodFor(
    module: NonNullable<ReturnType<typeof getModule>>,
    action: ProvisioningActionName,
) {
    const table = {
        create: module.create,
        suspend: module.suspend,
        unsuspend: module.unsuspend,
        terminate: module.terminate,
        change_package: module.changePackage,
        power: module.power,
        reinstall: module.reinstall,
        sync: module.getStatus,
    } as const;

    const method = table[action];

    return method ? method.bind(module) : null;
}

/**
 * The way back, in one place.
 *
 * Called by exactly one thing: a `terminate` that came back successfully.
 * The addresses go to the pool with their rDNS cleared, and the reserved
 * VMID row is deleted so the cluster may hand that id out again. Both halves
 * are the mirror of what `create` took, which is why they are one function
 * and not two statements somebody has to remember to pair.
 */
async function release(
    tx: Tx,
    serviceId: string,
): Promise<{ addresses: number; resource: boolean }> {
    const addresses = await releaseAddresses(tx, serviceId);

    const removed = await tx
        .delete(schema.provisioningResource)
        .where(eq(schema.provisioningResource.serviceId, serviceId))
        .returning({ id: schema.provisioningResource.id });

    return { addresses, resource: removed.length > 0 };
}

async function applyResult(
    tx: Tx,
    input: {
        task: typeof schema.provisioningTask.$inferSelect;
        service: Service;
        result: ModuleResult;
        at: Date;
        released: { addresses: number; resource: boolean } | null;
    },
): Promise<void> {
    const { task, service, result, at } = input;

    await tx
        .update(schema.provisioningTask)
        .set({
            status: "succeeded",
            finishedAt: at,
            lastError: null,
            result: {
                summary: result.summary,
                alreadyDone: result.alreadyDone ?? false,
                warnings: result.warnings ?? [],
                ...(result.data ?? {}),
                ...(input.released ? { released: input.released } : {}),
            },
            updatedAt: at,
        })
        .where(eq(schema.provisioningTask.id, task.id));

    /**
     * The only two results that move `service.status`, and both are the
     * module reporting on work we asked for — see the module header on why a
     * *reading* never does.
     *
     * Both are narrowed with a `WHERE` on the status they may come from, so
     * a create that finishes after an operator has already terminated the
     * service does not resurrect it, and a terminate that finishes after the
     * Abo was reinstated does not tear down a machine that is wanted again.
     */
    if (task.action === "create") {
        await tx
            .update(schema.service)
            .set({
                status: "active",
                activatedAt: service.activatedAt ?? at,
                suspendedAt: null,
                updatedAt: at,
            })
            .where(
                and(
                    eq(schema.service.id, service.id),
                    inArray(schema.service.status, ["pending", "provisioning"]),
                ),
            );
    }

    if (task.action === "terminate") {
        await tx
            .update(schema.service)
            .set({
                status: "terminated",
                terminatedAt: service.terminatedAt ?? at,
                updatedAt: at,
            })
            .where(
                and(
                    eq(schema.service.id, service.id),
                    sql`${schema.service.status} <> 'terminated'`,
                ),
            );
    }
}

async function writeProviderStatus(
    db: Db,
    serviceId: string,
    status: ProviderStatus,
    at: Date,
): Promise<void> {
    await db
        .update(schema.service)
        .set({
            providerStatus: status.missing ? "missing" : status.state,
            providerStatusAt: at,
            providerStatusDetail: status.detail?.slice(0, 500) ?? null,
            ...(status.data
                ? {
                      moduleData: sql`${schema.service.moduleData} || ${JSON.stringify(
                          status.data,
                      )}::jsonb`,
                  }
                : {}),
            updatedAt: at,
        })
        .where(eq(schema.service.id, serviceId));
}

async function finish(
    db: Db,
    taskId: string,
    input: {
        status: "succeeded" | "failed" | "aborted";
        error?: string | null;
        at: Date;
        runAfter?: Date | null;
        result?: Record<string, unknown>;
        summary?: string;
        resetProvisioning?: boolean;
        serviceId?: string;
    },
): Promise<void> {
    await db
        .update(schema.provisioningTask)
        .set({
            status: input.status,
            finishedAt: input.status === "failed" ? null : input.at,
            lastError: input.error?.slice(0, 2000) ?? null,
            ...(input.runAfter ? { runAfter: input.runAfter } : {}),
            ...(input.result ? { result: input.result } : {}),
            updatedAt: input.at,
        })
        .where(eq(schema.provisioningTask.id, taskId));

    if (input.resetProvisioning && input.serviceId) {
        await db
            .update(schema.service)
            .set({ status: "pending", updatedAt: input.at })
            .where(
                and(
                    eq(schema.service.id, input.serviceId),
                    eq(schema.service.status, "provisioning"),
                ),
            );
    }
}

async function abort(
    db: Db,
    taskId: string,
    input: {
        error: string;
        allocated: readonly string[];
        serviceId: string;
        attempts: number;
        at: Date;
        resourceId?: string | null;
    },
): Promise<void> {
    await db.transaction(async (tx) => {
        if (input.allocated.length > 0) {
            await releaseAddressIds(tx, input.serviceId, input.allocated);
        }

        if (input.resourceId) {
            await tx
                .delete(schema.provisioningResource)
                .where(eq(schema.provisioningResource.id, input.resourceId));
        }

        await tx
            .update(schema.provisioningTask)
            .set({
                status: "aborted",
                finishedAt: input.at,
                lastError: input.error.slice(0, 2000),
                /**
                 * A backoff even though the task is "aborted": the sweep
                 * re-requests it, and without one a service stuck behind an
                 * empty pool would ask the cluster for its node list every
                 * sixty seconds for as long as it is stuck.
                 */
                runAfter: new Date(
                    input.at.getTime() + backoffSeconds(input.attempts) * 1000,
                ),
                updatedAt: input.at,
            })
            .where(eq(schema.provisioningTask.id, taskId));

        /** Nothing is being provisioned any more. Say so. */
        await tx
            .update(schema.service)
            .set({ status: "pending", updatedAt: input.at })
            .where(
                and(
                    eq(schema.service.id, input.serviceId),
                    eq(schema.service.status, "provisioning"),
                ),
            );
    });
}

/** Opens a service's stored credentials. `server-only`, and audited by callers. */
export function readServiceCredentials(
    service: Pick<Service, "id" | "credentialsEncrypted">,
): Record<string, string> | null {
    if (!service.credentialsEncrypted) {
        return null;
    }

    try {
        return JSON.parse(
            decrypt(
                service.credentialsEncrypted,
                CREDENTIAL_CONTEXT(service.id),
            ),
        ) as Record<string, string>;
    } catch (error) {
        console.error(
            `[provisioning] the stored credentials for ${service.id} could not be decrypted:`,
            error,
        );

        return null;
    }
}

export type SweepReport = {
    considered: number;
    ran: number;
    ok: number;
    failed: number;
};

/**
 * Every runnable task, in order.
 *
 * Sequential rather than parallel. These calls hit one operator's hypervisor
 * and a clone is minutes of disk I/O; twenty at once is a cluster that stops
 * answering and twenty tasks that then all report a timeout. The queue's own
 * ordering is `run_after`, so the oldest request goes first.
 */
export async function runProvisioningSweep(
    db: Db,
    options: RunOptions & { limit?: number } = {},
): Promise<SweepReport> {
    const at = options.at ?? new Date();
    const ids = await runnableTasks(db, options.limit ?? 25, at);
    const report: SweepReport = {
        considered: ids.length,
        ran: 0,
        ok: 0,
        failed: 0,
    };

    for (const id of ids) {
        const outcome = await runProvisioningTask(db, id, {
            ...options,
            at: new Date(),
        });

        if (!outcome.ran) {
            continue;
        }

        report.ran += 1;

        if (outcome.ok) {
            report.ok += 1;
        } else {
            report.failed += 1;
        }
    }

    return report;
}
