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

/**
 * Phase 7. Two queues rather than one, because they answer two different
 * questions and want two different cadences:
 *
 *  - `tickets/sweep` drains the notifications the webhook wrote and runs the
 *    delta reconciliation. Every five minutes, which is what the build plan
 *    asks for and what makes a missed notification cost latency rather than
 *    a message.
 *  - `tickets/subscriptions` keeps the Graph change-notification
 *    subscriptions alive. Graph grants at most 4230 minutes and then stops
 *    delivering without saying so; this renews with a day to spare.
 */
export const TICKET_SWEEP_QUEUE = "tickets/sweep";
export const TICKET_SUBSCRIPTION_QUEUE = "tickets/subscriptions";

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
    {
        name: TICKET_SWEEP_QUEUE,
        /**
         * One sweep at a time. Two would not corrupt anything — every
         * message is claimed before it is touched — but they would spend
         * their Graph quota racing each other to be told "already handled".
         */
        policy: "singleton" as const,
        /**
         * One retry, five minutes out. A sweep that failed is picked up by
         * the next scheduled one anyway, and a long retry ladder would have
         * two sweeps in flight at the cadence this runs at.
         */
        retryLimit: 1,
        retryDelay: 300,
        expireInSeconds: 600,
        deleteAfterSeconds: 7 * 86_400,
    },
    {
        name: TICKET_SUBSCRIPTION_QUEUE,
        policy: "singleton" as const,
        retryLimit: 2,
        retryDelay: 600,
        expireInSeconds: 300,
        deleteAfterSeconds: 7 * 86_400,
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

/**
 * The mail sweep, every five minutes. UTC rather than Berlin on purpose:
 * unlike the billing day, "every five minutes" means the same thing in
 * every zone, and naming one would only make the schedule skip or repeat an
 * interval twice a year.
 */
export const TICKET_SWEEP_CRON = "*/5 * * * *";

/**
 * The subscription renewal, hourly. The grant is nearly three days and the
 * renewal happens with a day left, so hourly is twenty-four chances to get
 * it done — which is the right ratio for something whose silent failure
 * stops inbound mail.
 */
export const TICKET_SUBSCRIPTION_CRON = "0 * * * *";

/**
 * A missed sweep is **not** made up. `once` would send a job for an
 * occurrence the next scheduled pass is about to overtake anyway; there is
 * nothing a five-minute-old sweep can do that the one in two minutes' time
 * will not. `skip` is pg-boss's own default and is named here so the
 * difference from the billing run's `once` is on purpose rather than by
 * omission.
 */
export const TICKET_MISSED = "skip" as const;
