import "server-only";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { ProvisioningActionName } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { getModule } from "./index";

/**
 * Enqueueing a module call, and claiming it before it runs.
 *
 * ## What `provisioning_task (service_id, action, request_key)` speaks for
 *
 * **One request to do one thing to one service.** Not one attempt, not one
 * pg-boss job, not one pass of the sweep. The caller says which request it
 * is, and every caller's key is in the table below — written out because
 * Phase 6 shipped a day-scoped claim taken by a customer-scoped pass and
 * Phase 7 shipped a per-mailbox claim behind an installation-wide unique
 * index, and both times the defect was this question answered carelessly.
 *
 * | caller | key | what makes it right |
 * |---|---|---|
 * | the create sweep, `emitInvoicePaid`, the operator's button | `"create"` | A service is created **once, for ever**. Every source of "this service should exist now" is the same request, so the second one finds the first's row and adds nothing. |
 * | `applyServiceFollow` (suspend / unsuspend / terminate) | the id of the status change that caused it | The caller mints it and passes it in. It is unique per occurrence, so the Abo being suspended twice over a year is two requests — while the same transition hooking twice is one. |
 * | `changes.ts` (plan change) | the subscription-change row's id, or the item id plus the instant it was applied | One agreed change is one package change. |
 * | a power action | a ULID minted at the click | A customer pressing „Neustart“ twice **means** two reboots, and a reboot is not idempotent — so the key must differ. |
 * | a reinstall | a ULID minted at the click | The same, and it destroys data, so it is never retried either. |
 * | `sync` | the UTC hour | A reading is worth taking again soon, and worth taking only once per sweep. |
 *
 * ## What it deliberately does *not* speak for
 *
 * Whether a VM exists. That is `provisioning_resource`, keyed on the
 * provider's own id — see its header. If this row were the only guard, a
 * create whose first attempt timed out would have no way to tell "my request
 * never arrived" from "my request arrived and the answer did not", and the
 * answer it guessed wrong would be a second machine.
 *
 * ## Why the row is also the queue
 *
 * The web process holds no pg-boss instance (see `src/server/jobs/worker.ts`)
 * and is not going to grow one, so there is nothing to `send` a job to from a
 * server action or a webhook. A `pending` row **is** the work: the worker's
 * `provisioning/run` pass drains it, and the operator's "jetzt ausführen"
 * runs the same function against the same claim. Those two cannot
 * double-run, which is the property that matters — pg-boss would have given
 * retries and backoff, and the row carries those itself (`attempts`,
 * `max_attempts`, `run_after`).
 */

type Db = typeof defaultDb;
type Tx = Pick<Db, "select" | "update" | "insert" | "delete">;

/**
 * How many times an action may be attempted, and why.
 *
 * **Per action, not per queue.** A uniform retry limit is how a reboot
 * reboots twice and a reinstall destroys a customer's data twice. The
 * idempotent ones get a ladder because the thing that usually fails them is
 * a network; the ones that are not idempotent get exactly one go, and a
 * failure is a thing for a person.
 */
export const MAX_ATTEMPTS: Record<ProvisioningActionName, number> = {
    /** Idempotent through the reserved VMID: a retry asks and then acts. */
    create: 5,
    suspend: 5,
    unsuspend: 5,
    /** "Already gone" is a success, so a retry converges. */
    terminate: 5,
    change_package: 3,
    /**
     * **One.** `reboot` is not idempotent — a retry is a second reboot of a
     * machine whose owner asked for one — and `stop` on a guest that was
     * already shutting down is a second hard power cut. A failed power
     * action is shown to whoever pressed the button, who can press it again.
     */
    power: 1,
    /** **One.** It destroys data. Nothing automatic may do that twice. */
    reinstall: 1,
    /** A reading. The next sweep takes a fresh one anyway. */
    sync: 2,
};

/**
 * How long to wait after a failed attempt.
 *
 * Exponential from one minute, capped at an hour. The cap is deliberate: a
 * create that has failed four times is waiting for a person, and a ladder
 * that reached six hours would mean the person's fix does not take effect
 * until the evening. „Jetzt ausführen“ clears `run_after` anyway.
 */
export function backoffSeconds(attempts: number): number {
    return Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3_600);
}

export type EnqueueInput = {
    serviceId: string;
    action: ProvisioningActionName;
    /** See the table in the header. Unique per *request*, not per attempt. */
    requestKey: string;
    payload?: Record<string, unknown>;
    requestedBy?: string | null;
    /** Run it no earlier than this. Defaults to now. */
    runAfter?: Date;
};

export type EnqueueResult = {
    taskId: string;
    /** False when this request was already on the queue. */
    created: boolean;
};

/**
 * Puts one request on the queue, or finds the one that is already there.
 *
 * Runs **inside the caller's transaction** on purpose: a suspension that is
 * rolled back must not leave a suspend task behind, and a suspension that
 * commits must not be able to commit without one.
 *
 * A request that has already succeeded is **not** re-opened. That is the
 * loop-breaker for the whole phase: `create` is keyed `"create"` for ever, so
 * the create sweep running every minute against a service that is already
 * `active` finds a succeeded row and does nothing at all. A failed one *is*
 * re-opened, with its attempt count kept — the caller asking again is a
 * reason to try again, not a reason to forget that four tries have already
 * gone.
 */
export async function enqueueTask(
    tx: Tx,
    input: EnqueueInput,
): Promise<EnqueueResult> {
    const [service] = await tx
        .select({
            id: schema.service.id,
            module: schema.service.module,
            status: schema.service.status,
        })
        .from(schema.service)
        .where(eq(schema.service.id, input.serviceId))
        .limit(1);

    if (!service) {
        throw new Error(`Unknown service ${input.serviceId}`);
    }

    /**
     * A module that provisions nothing has nothing to be asked. Enqueueing
     * for `none` would fill the queue with rows that can only ever fail, and
     * would make "there is no machine" indistinguishable from "the machine
     * could not be reached".
     */
    const module = getModule(service.module);

    if (!module?.provisions) {
        return { taskId: "", created: false };
    }

    const id = createId("provtask");
    const now = new Date();

    const inserted = await tx
        .insert(schema.provisioningTask)
        .values({
            id,
            serviceId: input.serviceId,
            module: service.module,
            action: input.action,
            requestKey: input.requestKey,
            payload: input.payload ?? {},
            maxAttempts: MAX_ATTEMPTS[input.action],
            runAfter: input.runAfter ?? now,
            requestedBy: input.requestedBy ?? null,
        })
        .onConflictDoNothing({
            target: [
                schema.provisioningTask.serviceId,
                schema.provisioningTask.action,
                schema.provisioningTask.requestKey,
            ],
        })
        .returning({ id: schema.provisioningTask.id });

    if (inserted[0]) {
        return { taskId: inserted[0].id, created: true };
    }

    const [existing] = await tx
        .select({
            id: schema.provisioningTask.id,
            status: schema.provisioningTask.status,
            attempts: schema.provisioningTask.attempts,
            maxAttempts: schema.provisioningTask.maxAttempts,
        })
        .from(schema.provisioningTask)
        .where(
            and(
                eq(schema.provisioningTask.serviceId, input.serviceId),
                eq(schema.provisioningTask.action, input.action),
                eq(schema.provisioningTask.requestKey, input.requestKey),
            ),
        )
        .limit(1);

    if (!existing) {
        // The conflict target matched something that then vanished. Nothing
        // sensible to do but say the request is not queued.
        return { taskId: "", created: false };
    }

    /**
     * `failed` and `aborted` are re-opened; `succeeded`, `pending` and
     * `running` are left exactly as they are. See the header: this is what
     * makes a sweep safe to run every minute.
     *
     * **A request with no attempts left is not re-opened.** Both halves of
     * this were right on their own and wedged a service together: the
     * attempt count is kept on purpose (asking again is not a reason to
     * forget that five tries have gone), and the sweep re-opens a failed row
     * once a minute. So a create that had spent its ladder was relabelled
     * `pending`, where `claimTask` would not take it — `attempts <
     * max_attempts` — and „Erneut versuchen“, which matches `failed` and
     * `aborted`, no longer saw it either. The row read as queued, nothing
     * could run it, and the only way out was SQL. A spent request stays
     * visibly spent until a person gives it its attempts back.
     */
    if (
        (existing.status === "failed" || existing.status === "aborted") &&
        existing.attempts < existing.maxAttempts
    ) {
        await tx
            .update(schema.provisioningTask)
            .set({
                status: "pending",
                /**
                 * Asking again does not jump the queue. A task that aborted
                 * carries a backoff, and the create sweep asking once a
                 * minute must not reset it to now — that would turn a
                 * service stuck on "no node has memory" into a `GET /nodes`
                 * every sixty seconds for as long as it is stuck.
                 */
                /**
                 * The instant goes in as an ISO **string** cast to
                 * `timestamp`. These columns are plain `timestamp` and a
                 * `Date` bound into a hand-written `sql` fragment is
                 * serialized with the server's local offset, which Postgres
                 * then drops — so every re-opened task was pushed a whole
                 * hour into the future in Europe/Berlin (two in summer)
                 * rather than being asked for again a minute later. Drizzle's
                 * own typed comparisons go through its mapper and are fine;
                 * raw fragments are not.
                 */
                runAfter: sql`greatest(${schema.provisioningTask.runAfter}, ${(
                    input.runAfter ?? now
                ).toISOString()}::timestamp)`,
                payload: input.payload ?? {},
                requestedBy: input.requestedBy ?? null,
                updatedAt: now,
            })
            .where(eq(schema.provisioningTask.id, existing.id));
    }

    return { taskId: existing.id, created: false };
}

/** Enqueues the same action for several services, one request each. */
export async function enqueueForServices(
    tx: Tx,
    serviceIds: readonly string[],
    input: Omit<EnqueueInput, "serviceId">,
): Promise<EnqueueResult[]> {
    const results: EnqueueResult[] = [];

    for (const serviceId of serviceIds) {
        results.push(await enqueueTask(tx, { ...input, serviceId }));
    }

    return results;
}

/**
 * How long a claim is good for.
 *
 * `claimTask` writes `running` and the module call then runs for minutes
 * outside any transaction, so the row is the only record that somebody has
 * it — and a worker that is killed mid-clone (a redeploy, an OOM) leaves it
 * behind. Without a lease that row is `running` for ever: no sweep, no
 * button and no API call can touch it again, and a `create` holds its
 * service in `provisioning` with it.
 *
 * Half an hour is longer than the longest call this module can make — a
 * clone waits `taskTimeoutMs` and every request inside it is bounded — so a
 * lease that has run out means the process is gone, not slow. The attempt
 * it spent stays spent, which is what keeps a call that reliably kills the
 * worker from being retried for ever.
 */
export const TASK_LEASE_SECONDS = 1_800;

/**
 * The instant a claim older than this is no longer anybody's.
 *
 * Rendered as an ISO **string** cast to `timestamp`, not bound as a `Date`.
 * These columns are plain `timestamp` (the repo-wide rule 9 backlog), and a
 * `Date` bound into raw SQL is serialized by node-postgres with the server's
 * local offset — which Postgres then drops, leaving a value an hour out in
 * Europe/Berlin. Drizzle's own column comparisons go through its mapper and
 * do not have this problem; a hand-written `sql` fragment does. The first
 * version of the lease was an hour wrong in summer and silently never
 * reclaimed anything.
 */
function leaseCutoff(at: Date): string {
    return new Date(at.getTime() - TASK_LEASE_SECONDS * 1000).toISOString();
}

/** A claim nobody is holding any more. */
function staleClaim(at: Date) {
    return and(
        eq(schema.provisioningTask.status, "running"),
        sql`${schema.provisioningTask.startedAt} < ${leaseCutoff(at)}::timestamp`,
    );
}

/**
 * Another task is working on this service right now.
 *
 * One service, one call at a time. Two tasks on one machine is how a
 * `terminate` that overtakes an in-flight `create` releases the addresses
 * the create is at that moment writing into cloud-init — and the queue is
 * otherwise perfectly happy to run them side by side, because the worker's
 * sweep and the operator's button claim different rows.
 */
function busyService(taskId: string, at: Date) {
    return sql`not exists (
        select 1
          from provisioning_task other
         where other.service_id = provisioning_task.service_id
           and other.id <> ${taskId}
           and other.status = 'running'
           and other.started_at >= ${leaseCutoff(at)}::timestamp
    )`;
}

/**
 * Claims one task for this pass. Returns null when somebody else has it.
 *
 * The same shape as `claimEvent()` and `claimInboundMail()`: one conditional
 * statement rather than a read followed by a write, because the gap between
 * those two is where two workers both decide the task is theirs. `attempts`
 * goes up here and not at the end, so a process that dies mid-call has still
 * spent an attempt — otherwise a call that reliably kills the worker would
 * be retried for ever.
 */
export async function claimTask(
    tx: Tx,
    taskId: string,
    at: Date = new Date(),
): Promise<typeof schema.provisioningTask.$inferSelect | null> {
    const claimed = await tx
        .update(schema.provisioningTask)
        .set({
            status: "running",
            attempts: sql`${schema.provisioningTask.attempts} + 1`,
            startedAt: at,
            updatedAt: at,
        })
        .where(
            and(
                eq(schema.provisioningTask.id, taskId),
                or(
                    inArray(schema.provisioningTask.status, [
                        "pending",
                        "failed",
                    ]),
                    staleClaim(at),
                ),
                busyService(taskId, at),
                lte(schema.provisioningTask.runAfter, at),
                /**
                 * The attempt ladder is enforced here and not only in the
                 * sweep's query, because "jetzt ausführen" and the API route
                 * claim by id and would otherwise walk straight past it —
                 * which for `power` and `reinstall`, whose ladder is one
                 * rung, is the difference between a button and a second
                 * reinstall.
                 */
                sql`${schema.provisioningTask.attempts} < ${schema.provisioningTask.maxAttempts}`,
            ),
        )
        .returning();

    return claimed[0] ?? null;
}

/** Everything runnable, oldest first. The sweep's one query. */
export async function runnableTasks(
    db: Pick<Db, "select">,
    limit = 25,
    at: Date = new Date(),
): Promise<string[]> {
    const rows = await db
        .select({ id: schema.provisioningTask.id })
        .from(schema.provisioningTask)
        .where(
            and(
                or(
                    inArray(schema.provisioningTask.status, [
                        "pending",
                        "failed",
                    ]),
                    staleClaim(at),
                ),
                sql`${schema.provisioningTask.attempts} < ${schema.provisioningTask.maxAttempts}`,
                lte(schema.provisioningTask.runAfter, at),
            ),
        )
        .orderBy(
            asc(schema.provisioningTask.runAfter),
            asc(schema.provisioningTask.id),
        )
        .limit(limit);

    return rows.map((row) => row.id);
}

export async function tasksForService(
    db: Pick<Db, "select">,
    serviceId: string,
    limit = 25,
) {
    return db
        .select()
        .from(schema.provisioningTask)
        .where(eq(schema.provisioningTask.serviceId, serviceId))
        .orderBy(sql`${schema.provisioningTask.createdAt} desc`)
        .limit(limit);
}

/** The hour a `sync` request belongs to, in UTC. */
export function syncWindow(at: Date): string {
    return at.toISOString().slice(0, 13);
}
