#!/usr/bin/env node
/**
 * The background worker: pg-boss, the daily `billing:run` schedule, and
 * nothing else.
 *
 * Runs as its own process — `npm run worker`, or a second container beside
 * the web one in Dokploy. See `src/server/jobs/worker.ts` for why it is not
 * a timer inside the Next server.
 *
 * It exits non-zero on a start-up failure so the supervisor restarts it, and
 * it stops gracefully on SIGINT/SIGTERM: a renewal pass that is halfway
 * through is allowed to finish, because a pass that is killed in the middle
 * leaves half a day's invoices raised and the rest not. Nothing is lost
 * either way — every step claims its row before acting — but finishing is
 * cheaper than resuming.
 */
import { startWorker } from "@/server/jobs/worker";

const worker = await startWorker().catch((error) => {
    console.error("[worker] could not start:", error);
    process.exit(1);
});

let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        if (stopping) {
            // A second Ctrl-C means "now", not "again".
            process.exit(130);
        }

        stopping = true;
        console.log(`[worker] ${signal} — finishing the job in flight…`);

        worker
            .stop()
            .then(() => process.exit(0))
            .catch((error) => {
                console.error("[worker] stopping failed:", error);
                process.exit(1);
            });
    });
}
