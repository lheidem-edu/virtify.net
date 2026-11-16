import "server-only";
import type { db as defaultDb } from "@/db";
import { queueMail } from "@/server/mail/outbox";
import { loadSettings, type Settings } from "@/server/settings";
import type { DomainEventOf } from "./catalog";
import { markEventDispatched, pendingEvents, recordEventFailure } from "./emit";
import { notificationsFor } from "./notify";

/**
 * Turning facts into notifications.
 *
 * One pass over the events nobody has dealt with yet. For each: ask the
 * notifiers what mail it wants, write those rows, mark the event dispatched —
 * **all three in one transaction**, so an event is never marked handled with
 * only half its mail queued, and a transaction that rolls back leaves the
 * event exactly as runnable as it was.
 *
 * That the three are in one transaction is safe precisely because each mail
 * row is claimed under `email_log (template, to_email, dedupe_key)`: a retry
 * of a dispatch that failed after queueing two of three rows re-queues all
 * three, finds two already there and adds the one that was missing. The
 * conflict is doing the work, not the transaction.
 *
 * ## It does not send
 *
 * Nothing here talks to a relay. The dispatcher's whole job is to turn a row
 * in one table into rows in another; the outbox sweep sends. Keeping the two
 * apart is what lets the dispatcher hold a transaction at all — a mail relay
 * that hangs inside one would hold its row locks with it, which is the same
 * reason `notices.ts` has always been kept out of `run.ts`.
 */

export type DispatchReport = {
    dispatched: number;
    queued: number;
    failed: number;
};

/**
 * Dispatches one event. Exported so a test can drive a single fact, and so
 * the caller that *just* emitted one could push it through immediately —
 * nothing does that today, and nothing should: the point of the row is that
 * the sweep picks it up whether or not the emitting process survives.
 */
export async function dispatchEvent(
    db: typeof defaultDb,
    event: DomainEventOf,
    settings: Settings,
): Promise<number> {
    return db.transaction(async (tx) => {
        const requests = await notificationsFor(event, {
            // The notifier gets the transaction, narrowed to `select`. It
            // reads inside the same snapshot that will mark the event
            // dispatched, so it cannot see a half-committed world — and it
            // still cannot write, which is the rule.
            db: tx,
            settings,
        });

        let queued = 0;

        for (const request of requests) {
            const id = await queueMail(tx, request);

            if (id) {
                queued += 1;
            }
        }

        await markEventDispatched(tx, event.id);

        return queued;
    });
}

export async function dispatchEvents(
    db: typeof defaultDb,
    options: { now?: Date; limit?: number; settings?: Settings } = {},
): Promise<DispatchReport> {
    const now = options.now ?? new Date();
    const report: DispatchReport = { dispatched: 0, queued: 0, failed: 0 };

    const events = await pendingEvents(db, { now, limit: options.limit ?? 50 });

    if (events.length === 0) {
        return report;
    }

    const settings = options.settings ?? (await loadSettings());

    for (const event of events) {
        try {
            report.queued += await dispatchEvent(db, event, settings);
            report.dispatched += 1;
        } catch (error) {
            /**
             * One event's failure must not stop the pass: a payload that no
             * longer parses, or a customer row that has gone, would otherwise
             * hold up every notification behind it. The row keeps its ladder
             * and the next pass tries again; when the ladder runs out it
             * becomes `abandoned` and waits for a person.
             */
            console.error(`[events] dispatching ${event.id} failed:`, error);

            await recordEventFailure(
                db,
                {
                    // The counters come from the row the select already read,
                    // so the ladder is the row's own and not one this pass
                    // invented.
                    id: event.id,
                    attempts: event.attempts,
                    maxAttempts: event.maxAttempts,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
                now,
            );

            report.failed += 1;
        }
    }

    return report;
}
