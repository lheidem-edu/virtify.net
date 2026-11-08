import "server-only";
import { PgBoss } from "pg-boss";
import { db } from "@/db";
import { runBilling } from "@/server/billing/run";
import {
    BILLING_RUN_CRON,
    BILLING_RUN_MISSED,
    BILLING_RUN_QUEUE,
    BILLING_RUN_TZ,
    QUEUES,
} from "./queues";

/**
 * The worker: a process of its own, started by `npm run worker`, that owns
 * pg-boss and runs the schedule.
 *
 * **Why a separate process rather than a timer inside the web server.** A
 * Next server is scaled by the platform and restarted on every deploy; a
 * timer inside it would run as many times as there are instances and would
 * be killed halfway through a renewal pass by an ordinary redeploy. The
 * worker is one container, restarted on its own terms, and the job it is
 * running survives a restart because pg-boss keeps it in Postgres.
 *
 * The web process deliberately holds **no** pg-boss instance. It never needs
 * one: the admin area's "jetzt abrechnen" calls `runBilling()` directly, in
 * the request, so the operator sees what happened instead of watching a
 * queue; and the Jobs page reads pg-boss's own tables read-only. That keeps
 * the lifecycle of a background library out of a request-scoped server,
 * which is the usual way one of these ends up with a leaked pool per hot
 * reload.
 *
 * Nothing here decides anything. `runBilling()` is the whole of the work and
 * it is safe to run twice (see its header); the worker only says when.
 */

export type Worker = {
    boss: PgBoss;
    stop: () => Promise<void>;
};

function connectionString(): string {
    const url = process.env.DATABASE_URL;

    if (!url) {
        throw new Error(
            "DATABASE_URL is not set. The worker cannot run without it.",
        );
    }

    return url;
}

export function createBoss(): PgBoss {
    return new PgBoss({
        connectionString: connectionString(),
        /**
         * Its own schema, so pg-boss's twenty-odd tables and partitions do
         * not sit beside ours and a `\dt` still shows the application.
         */
        schema: "pgboss",
        // The worker is the only process that may create or migrate it.
        migrate: true,
        supervise: true,
        /**
         * One connection is plenty for polling and one job at a time. The
         * work itself runs against the application's own pool.
         */
        max: 4,
    });
}

export async function startWorker(): Promise<Worker> {
    const boss = createBoss();

    boss.on("error", (error) => {
        console.error("[worker] pg-boss:", error);
    });

    await boss.start();

    for (const queue of QUEUES) {
        await boss.createQueue(queue.name, queue);
    }

    await boss.work<{ force?: boolean; customerId?: string | null }>(
        BILLING_RUN_QUEUE,
        // One at a time. The pass is minutes of work against the same rows;
        // two of them would only queue behind each other's locks.
        { batchSize: 1 },
        async ([job]) => {
            const started = Date.now();

            console.log(`[worker] ${BILLING_RUN_QUEUE} ${job.id} started`);

            const result = await runBilling(db, {
                force: job.data?.force ?? false,
                forcedBy: job.data?.force ? "worker" : null,
                customerId: job.data?.customerId ?? null,
                // See `BillingRunContext.renderPdf`: the PDF renderer cannot
                // be loaded from a plain Node process, and the document is
                // rendered on first access anyway.
                renderPdf: false,
            });

            console.log(
                `[worker] ${BILLING_RUN_QUEUE} ${job.id} ${
                    result.ran ? "finished" : "skipped (day already claimed)"
                } in ${Date.now() - started}ms`,
                result.report,
            );

            /**
             * A step that failed is reported, not thrown. The pass finished;
             * what did not work is in `billing_run.report.failures` and on
             * the Jobs page, and throwing would retry the whole pass — which
             * is safe but pointless, because every step that *did* work
             * finds its row already claimed and does nothing.
             */
        },
    );

    await boss.schedule(BILLING_RUN_QUEUE, BILLING_RUN_CRON, null, {
        tz: BILLING_RUN_TZ,
        missed: BILLING_RUN_MISSED,
    });

    console.log(
        `[worker] ready — ${BILLING_RUN_QUEUE} at "${BILLING_RUN_CRON}" ${BILLING_RUN_TZ}`,
    );

    return {
        boss,
        stop: async () => {
            /**
             * Graceful: the job in flight is allowed to finish rather than
             * being killed mid-pass. The timeout is the ceiling the queue
             * itself sets (`expireInSeconds`), so a pass that is genuinely
             * stuck does not keep a container from stopping for ever.
             */
            await boss.stop({
                graceful: true,
                close: true,
                timeout: 3_600_000,
            });
        },
    };
}
