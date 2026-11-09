import "server-only";
import type { db as defaultDb } from "@/db";
import type { Actor } from "@/server/audit";
import {
    type CreateSweepReport,
    enqueueStatusSync,
    sweepPendingCreates,
} from "./hooks";
import { runProvisioningSweep, type SweepReport } from "./runner";

/**
 * What the worker calls, and what „jetzt ausführen“ in the admin area calls.
 *
 * One function, so the scheduled pass and the operator's button cannot drift
 * apart — the same arrangement `runBilling()` and `runTicketSweep()` have.
 *
 * Every part of it is safe to run twice: the claims underneath
 * (`provisioning_task`, `provisioning_resource`, `ip_address.service_id`)
 * decide what work is left, not the caller and not the clock. There is
 * deliberately no `provisioning_run (run_day)` equivalent of `billing_run`: a
 * provisioning pass is not a daily event that must happen once, it is a poll
 * that should happen often, and a row saying "the sweep has run today" would
 * be exactly the wrong claim to make.
 */

type Db = typeof defaultDb;

export type ProvisioningPassResult = {
    /** Services newly queued for setup. */
    queued: number;
    /** Status readings asked for. */
    syncs: number;
    sweep: SweepReport;
    createSweep: CreateSweepReport;
};

export async function runProvisioningPass(
    db: Db,
    options: {
        actor?: Actor;
        at?: Date;
        /** Skip the hourly reading, for a pass that only wants to drain. */
        sync?: boolean;
        limit?: number;
        fetchImpl?: typeof fetch;
    } = {},
): Promise<ProvisioningPassResult> {
    const at = options.at ?? new Date();

    /**
     * Queue first, drain second, in that order: a service that becomes
     * eligible between the two waits a minute, which is cheap, while the
     * other order would make every create wait a full cycle for no reason.
     */
    const createSweep = await sweepPendingCreates(db, {
        requestedBy: "worker",
    });

    const syncs = options.sync === false ? 0 : await enqueueStatusSync(db, at);

    const sweep = await runProvisioningSweep(db, {
        actor: options.actor ?? { type: "system", label: "worker" },
        limit: options.limit,
        fetchImpl: options.fetchImpl,
    });

    return { queued: createSweep.enqueued, syncs, sweep, createSweep };
}
