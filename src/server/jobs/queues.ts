/**
 * The queues, their options and the schedule — in one place and with no
 * imports that drag a database connection in, so the worker, the admin page
 * and a test can all read them.
 */

/**
 * The plan calls it `billing:run`; pg-boss refuses a colon in a queue name
 * (alphanumerics, `_`, `-`, `.` and `/` only), so the separator is a slash.
 * The run itself still signs its audit entries `billing:run`, which is the
 * name a person reading the log is looking for.
 */
export const BILLING_RUN_QUEUE = "billing/run";

/** Every queue the worker creates at boot. pg-boss 12 requires it up front. */
export const QUEUES = [
    {
        name: BILLING_RUN_QUEUE,
        /**
         * `singleton`: one of these runs at a time, whatever the fleet does.
         *
         * It is not what makes the run safe — `billing_run` and the unique
         * indexes under it are (see `src/server/billing/run.ts`) — but it
         * keeps two workers from spending an hour doing the same reads and
         * blocking on each other's row locks.
         */
        policy: "singleton" as const,
        /**
         * Three tries, half an hour apart. A renewal pass that failed on a
         * gateway timeout deserves another go within the day; one that fails
         * three times is a problem a person has to look at, and retrying it
         * into the evening would only bury the first failure.
         */
        retryLimit: 3,
        retryDelay: 1_800,
        /**
         * Generous: the pass walks every subscription, renders PDFs and
         * talks to Stripe. A limit that expired mid-pass would mark the job
         * failed while the work was still going on, and the retry would then
         * run beside it.
         */
        expireInSeconds: 3_600,
        deleteAfterSeconds: 30 * 86_400,
    },
];

/**
 * Daily, at 03:00 Berlin.
 *
 * Early enough that renewals and their collection are done before the
 * operator's morning, late enough that a European card network is at its
 * quietest. The time zone is named rather than left to UTC, because the
 * billing day this run claims is a Berlin calendar day and the two would
 * drift apart twice a year.
 */
export const BILLING_RUN_CRON = "0 3 * * *";
export const BILLING_RUN_TZ = "Europe/Berlin";

/**
 * What a missed occurrence does. `once` sends a single job for the most
 * recent one, however many were missed — which is exactly right here: a
 * deployment that was down for three days should run the pass once, and that
 * one pass picks up everything that fell due meanwhile, because every step
 * works from dates rather than from "what happened since yesterday".
 */
export const BILLING_RUN_MISSED = "once" as const;
