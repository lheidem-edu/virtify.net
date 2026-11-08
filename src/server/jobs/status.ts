import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { BillingRunReport } from "@/server/billing/run";
import {
    BILLING_RUN_CRON,
    BILLING_RUN_QUEUE,
    BILLING_RUN_TZ,
    TICKET_SUBSCRIPTION_CRON,
    TICKET_SUBSCRIPTION_QUEUE,
    TICKET_SWEEP_CRON,
    TICKET_SWEEP_QUEUE,
} from "./queues";

/**
 * What the admin Jobs page reads.
 *
 * Read-only, and deliberately through SQL rather than through a pg-boss
 * instance: the web process holds none (see `./worker.ts`), and a page that
 * starts a background library in order to render a table is a page that
 * leaks a connection pool on every hot reload.
 *
 * Every query here is wrapped, because `pgboss` is created by the worker and
 * a deployment that has never started one has no such schema. That is a
 * state the page has to be able to *show* — "der Worker läuft nicht" is the
 * single most useful thing this page can say — rather than one it crashes
 * on.
 */

export type QueueState = {
    name: string;
    queued: number;
    active: number;
    failed: number;
    completed: number;
};

export type FailedJob = {
    id: string;
    name: string;
    createdOn: Date;
    completedOn: Date | null;
    retryCount: number;
    output: unknown;
};

export type ScheduleState = {
    name: string;
    cron: string;
    timezone: string;
};

export type JobsOverview = {
    /** False when the `pgboss` schema does not exist: no worker has run. */
    workerInstalled: boolean;
    queues: QueueState[];
    failures: FailedJob[];
    schedules: ScheduleState[];
    /** What the schedules *should* be, whether or not they are installed. */
    expected: ScheduleState[];
};

async function pgbossExists(): Promise<boolean> {
    try {
        const result = await db.execute<{ present: boolean }>(
            sql`select exists (
                select 1 from information_schema.schemata
                where schema_name = 'pgboss'
            ) as present`,
        );

        return Boolean(result.rows[0]?.present);
    } catch (error) {
        console.error("[jobs] could not look for the pgboss schema:", error);
        return false;
    }
}

export async function jobsOverview(): Promise<JobsOverview> {
    const expected: ScheduleState[] = [
        {
            name: BILLING_RUN_QUEUE,
            cron: BILLING_RUN_CRON,
            timezone: BILLING_RUN_TZ,
        },
        {
            name: TICKET_SWEEP_QUEUE,
            cron: TICKET_SWEEP_CRON,
            timezone: "UTC",
        },
        {
            name: TICKET_SUBSCRIPTION_QUEUE,
            cron: TICKET_SUBSCRIPTION_CRON,
            timezone: "UTC",
        },
    ];

    if (!(await pgbossExists())) {
        return {
            workerInstalled: false,
            queues: [],
            failures: [],
            schedules: [],
            expected,
        };
    }

    try {
        const queues = await db.execute<{
            name: string;
            queued: string;
            active: string;
            failed: string;
            completed: string;
        }>(sql`
            select
                q.name,
                count(*) filter (where j.state in ('created', 'retry')) as queued,
                count(*) filter (where j.state = 'active') as active,
                count(*) filter (where j.state = 'failed') as failed,
                count(*) filter (where j.state = 'completed') as completed
            from pgboss.queue q
            left join pgboss.job j on j.name = q.name
            -- pg-boss keeps queues of its own for maintenance. They are its
            -- business, not the operator's.
            where q.name not like '\_\_pgboss\_\_%'
            group by q.name
            order by q.name
        `);

        const failures = await db.execute<{
            id: string;
            name: string;
            created_on: Date;
            completed_on: Date | null;
            retry_count: number;
            output: unknown;
        }>(sql`
            select id, name, created_on, completed_on, retry_count, output
            from pgboss.job
            where state = 'failed'
            order by created_on desc
            limit 20
        `);

        const schedules = await db.execute<{
            name: string;
            cron: string;
            timezone: string;
        }>(sql`select name, cron, timezone from pgboss.schedule order by name`);

        return {
            workerInstalled: true,
            queues: queues.rows.map((row) => ({
                name: row.name,
                queued: Number(row.queued),
                active: Number(row.active),
                failed: Number(row.failed),
                completed: Number(row.completed),
            })),
            failures: failures.rows.map((row) => ({
                id: row.id,
                name: row.name,
                createdOn: row.created_on,
                completedOn: row.completed_on,
                retryCount: row.retry_count,
                output: row.output,
            })),
            schedules: schedules.rows.map((row) => ({
                name: row.name,
                cron: row.cron,
                timezone: row.timezone,
            })),
            expected,
        };
    } catch (error) {
        // A pg-boss major version that moved a column is a page that should
        // still render the billing runs below it.
        console.error("[jobs] reading the queue state failed:", error);

        return {
            workerInstalled: true,
            queues: [],
            failures: [],
            schedules: [],
            expected,
        };
    }
}

export type BillingRunRow = {
    id: string;
    runDay: string;
    status: "running" | "finished" | "failed";
    forced: string | null;
    startedAt: Date;
    finishedAt: Date | null;
    report: BillingRunReport;
    error: string | null;
};

/** The last runs of `billing:run`, newest first. Our own table, not pg-boss's. */
export async function recentBillingRuns(limit = 30): Promise<BillingRunRow[]> {
    const rows = await db
        .select()
        .from(schema.billingRun)
        .orderBy(desc(schema.billingRun.runDay))
        .limit(limit);

    return rows.map((row) => ({
        id: row.id,
        runDay: row.runDay,
        status: row.status,
        forced: row.forced,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        report: row.report as BillingRunReport,
        error: row.error,
    }));
}

export async function billingRunFor(
    day: string,
): Promise<BillingRunRow | null> {
    const [row] = await db
        .select()
        .from(schema.billingRun)
        .where(eq(schema.billingRun.runDay, day));

    if (!row) {
        return null;
    }

    return {
        id: row.id,
        runDay: row.runDay,
        status: row.status,
        forced: row.forced,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        report: row.report as BillingRunReport,
        error: row.error,
    };
}
