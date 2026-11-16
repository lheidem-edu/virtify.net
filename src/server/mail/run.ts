import "server-only";
import type { db as defaultDb } from "@/db";
import { type DispatchReport, dispatchEvents } from "@/server/events/dispatch";
import { loadSettings } from "@/server/settings";
import { type OutboxReport, runMailOutbox } from "./outbox";

/**
 * One pass of the notification machinery: dispatch, then send.
 *
 * The order matters and it is the cheap direction. Dispatching first means a
 * fact that became true a second ago already has its `email_log` row by the
 * time the outbox looks, so a customer who has just paid gets their receipt
 * in this pass rather than the next one. The reverse order would add a
 * minute of latency to every notification for no gain.
 *
 * Nothing here decides anything. `dispatchEvents` turns rows in one table
 * into rows in another and `runMailOutbox` sends them; both are safe to run
 * twice (see their headers), and this only says when.
 *
 * It is the same function behind all three callers — the worker's schedule,
 * the operator's „jetzt senden" on the admin page, and the tests — which is
 * the property that matters: those cannot double-send, because they claim
 * the same rows.
 */

export type MailPassReport = {
    events: DispatchReport;
    outbox: OutboxReport;
};

export async function runMailPass(
    db: typeof defaultDb,
    options: { now?: Date; limit?: number } = {},
): Promise<MailPassReport> {
    const now = options.now ?? new Date();
    // Loaded once and handed down: the operator address, the site URL and the
    // mail transport setting are read for every message otherwise, and a
    // twenty-five-message pass should not be twenty-five settings reads.
    const settings = await loadSettings();

    const events = await dispatchEvents(db, { now, settings });
    const outbox = await runMailOutbox(db, {
        now,
        limit: options.limit,
        settings,
    });

    return { events, outbox };
}

/** Whether a pass found anything worth a log line. */
export function passDidSomething(report: MailPassReport): boolean {
    return (
        report.events.dispatched > 0 ||
        report.events.failed > 0 ||
        report.outbox.sent > 0 ||
        report.outbox.failed > 0 ||
        report.outbox.expired > 0
    );
}
