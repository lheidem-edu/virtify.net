import "server-only";
import { eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { ProvisioningActionName } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { getModule } from "./index";
import { type CustomerScope, loadService } from "./repository";
import { type RunOutcome, runProvisioningTask } from "./runner";
import { enqueueTask } from "./tasks";
import type { ConsoleTicket } from "./types";

/**
 * The one function every button and every endpoint goes through.
 *
 * Trap 5 of this phase, stated as a rule: **a power action is a side effect
 * on a real machine, so the API route and the server action must call the
 * same service function.** Two copies would be two answers to "may this
 * customer reboot this server", and the one that was wrong would be the one
 * somebody found.
 *
 * What it does, in order, is the whole of the authorisation story:
 *
 *  1. Resolves the service **through the caller's own customer scope**, so a
 *     customer naming somebody else's id gets `null` — which every caller
 *     turns into a 404, never a 403 (rule 5).
 *  2. Checks the action against the module's own `clientActions` when the
 *     caller is the customer. A module decides what its machines can be
 *     asked to do; the panel does not invent actions for it.
 *  3. Enqueues the request with a key that says what kind of request it is —
 *     see the table in `tasks.ts` — and runs it.
 *
 * It runs the task **inline**, in the request. That is deliberate: somebody
 * pressed a button and is looking at a spinner, and the claim is what makes
 * this safe to do beside a worker that is sweeping the same table. The queue
 * would only make them wait up to a minute to find out it did not work.
 */

type Db = typeof defaultDb;

/** What a caller may ask for, in the panel's vocabulary. */
export const SERVICE_ACTIONS = [
    "start",
    "stop",
    "shutdown",
    "reboot",
    "reinstall",
    "sync",
    "provision",
    "suspend",
    "unsuspend",
    "terminate",
] as const;

export type ServiceActionName = (typeof SERVICE_ACTIONS)[number];

export function isServiceAction(value: unknown): value is ServiceActionName {
    return (
        typeof value === "string" &&
        (SERVICE_ACTIONS as readonly string[]).includes(value)
    );
}

/**
 * The ones only staff may ask for, whatever a module publishes.
 *
 * Setting up, suspending and tearing down are the panel's own lifecycle, and
 * it is driven by what the billing says — a customer asking for an
 * `unsuspend` would be a customer lifting their own Sperre wegen
 * Zahlungsverzugs. `sync` is a reading and is on nobody's list of dangerous
 * things.
 */
export const STAFF_ONLY_ACTIONS: readonly ServiceActionName[] = [
    "provision",
    "suspend",
    "unsuspend",
    "terminate",
];

const POWER: Partial<Record<ServiceActionName, string>> = {
    start: "start",
    stop: "stop",
    shutdown: "shutdown",
    reboot: "reboot",
};

const TASK_ACTION: Record<ServiceActionName, ProvisioningActionName> = {
    start: "power",
    stop: "power",
    shutdown: "power",
    reboot: "power",
    reinstall: "reinstall",
    sync: "sync",
    provision: "create",
    suspend: "suspend",
    unsuspend: "unsuspend",
    terminate: "terminate",
};

export class ServiceActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ServiceActionError";
    }
}

export type ActionRequest = {
    serviceId: string;
    /** `ANY_CUSTOMER` for staff. Never derived from the request body. */
    customer: CustomerScope;
    action: ServiceActionName;
    actor: Actor;
    /** True when the caller is the customer themselves, not staff. */
    asCustomer: boolean;
    fetchImpl?: typeof fetch;
};

export type ActionResult = {
    /** Null when the service is not this caller's. The caller answers 404. */
    outcome: RunOutcome | null;
    taskId: string | null;
};

export async function requestServiceAction(
    db: Db,
    input: ActionRequest,
): Promise<ActionResult> {
    const loaded = await loadService(db, input.serviceId, input.customer);

    if (!loaded) {
        return { outcome: null, taskId: null };
    }

    const module = getModule(loaded.service.module);

    if (!module?.provisions) {
        throw new ServiceActionError(
            "Für diese Leistung gibt es nichts zu steuern — sie wird nur abgerechnet.",
        );
    }

    /**
     * **Belt, with braces below.** Today this is redundant: no registered
     * module publishes a lifecycle action in `clientActions`, so the next
     * check refuses these anyway — and
     * `tests/unit/provisioning-registry.test.ts` pins that disjointness, so
     * a module that broke it would fail the suite rather than quietly hand a
     * customer an `unsuspend`.
     *
     * It stays because the two checks answer different questions. The one
     * below asks "does this module offer this"; this one asks "may a
     * customer ever ask for this at all", and the answer to the second must
     * not depend on a module getting its own list right.
     */
    if (input.asCustomer && STAFF_ONLY_ACTIONS.includes(input.action)) {
        /**
         * Deliberately the same wording as an unknown action. Telling a
         * customer that `unsuspend` exists but is not for them is an
         * invitation; the action simply is not on their list.
         */
        throw new ServiceActionError(
            `„${input.action}“ ist für diese Leistung nicht vorgesehen.`,
        );
    }

    if (
        input.asCustomer &&
        input.action !== "sync" &&
        !loaded.clientActions.some((entry) => entry.id === input.action)
    ) {
        throw new ServiceActionError(
            `„${input.action}“ ist für diese Leistung nicht vorgesehen.`,
        );
    }

    const taskAction = TASK_ACTION[input.action];
    const power = POWER[input.action];

    /**
     * The request key, per the table in `tasks.ts`.
     *
     * `create` is `"create"` for ever: every source of "this service should
     * exist" is the same request, so an operator pressing „Jetzt einrichten“
     * while the sweep has already queued one gets the sweep's row rather
     * than a second machine.
     *
     * Everything else a person presses gets a fresh ULID, because pressing
     * „Neustart“ twice **means** two reboots and a reboot is not idempotent.
     */
    const requestKey =
        taskAction === "create" ? "create" : `manual:${createId("provtask")}`;

    const { taskId } = await db.transaction((tx) =>
        enqueueTask(tx, {
            serviceId: loaded.service.id,
            action: taskAction,
            requestKey,
            payload: power ? { power } : {},
            requestedBy:
                `${input.actor.type}:${input.actor.label ?? input.actor.id ?? "?"}`.slice(
                    0,
                    120,
                ),
        }),
    );

    if (!taskId) {
        throw new ServiceActionError(
            "Die Anfrage konnte nicht eingereiht werden.",
        );
    }

    const outcome = await runProvisioningTask(db, taskId, {
        actor: input.actor,
        fetchImpl: input.fetchImpl,
    });

    return { outcome, taskId };
}

/**
 * A console ticket, minted and audited.
 *
 * Not a task: it changes nothing, it is good for two minutes, and queueing a
 * credential that expires before the queue drains would be a button that
 * never works. It goes through the same scope check as everything else, and
 * the audit entry records that somebody opened a console on somebody's
 * machine — which is exactly as sensitive as a credential reveal.
 */
export async function requestConsole(
    db: Db,
    input: {
        serviceId: string;
        customer: CustomerScope;
        actor: Actor;
        fetchImpl?: typeof fetch;
    },
): Promise<ConsoleTicket | null> {
    const loaded = await loadService(db, input.serviceId, input.customer);

    if (!loaded) {
        return null;
    }

    if (loaded.service.status !== "active") {
        throw new ServiceActionError(
            `Die Leistung ist „${loaded.service.status}“ — dafür gibt es keine Konsole.`,
        );
    }

    const module = getModule(loaded.service.module);

    if (!module?.console) {
        throw new ServiceActionError("Dieses Modul bietet keine Konsole an.");
    }

    if (!loaded.externalId || !loaded.service.serverId) {
        throw new ServiceActionError(
            "Für diese Leistung ist noch keine Maschine angelegt.",
        );
    }

    const { getServer, serverConfig, serverCredentials } = await import(
        "./servers"
    );
    const row = await getServer(db, loaded.service.serverId);
    const credentials = row ? serverCredentials(row) : null;

    if (!row || !credentials) {
        throw new ServiceActionError(
            "Für den Server ist kein API-Token hinterlegt.",
        );
    }

    const [resource] = await db
        .select({ node: schema.provisioningResource.node })
        .from(schema.provisioningResource)
        .where(eq(schema.provisioningResource.serviceId, loaded.service.id))
        .limit(1);

    const ticket = await module.console({
        server: { config: serverConfig(row), credentials },
        resource: {
            externalId: loaded.externalId,
            node: resource?.node ?? null,
        },
        now: new Date(),
        fetchImpl: input.fetchImpl,
    });

    /**
     * Audited whether or not a ticket came back. Opening a console on
     * somebody's machine is exactly as sensitive as revealing its password,
     * and the entry records who looked — never the ticket, which is a live
     * credential for the next two minutes.
     */
    await audit(db, {
        actor: input.actor,
        action: "service.console.open",
        entityType: "service",
        entityId: loaded.service.id,
        after: {
            label: loaded.service.label,
            granted: ticket !== null,
            node: resource?.node ?? null,
        },
    });

    return ticket;
}
