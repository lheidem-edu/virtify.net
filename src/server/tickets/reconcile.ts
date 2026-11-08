import "server-only";
import { eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { MailChannel } from "./channels/types";
import {
    markNotificationFailed,
    markNotificationHandled,
    pendingNotifications,
} from "./claim";
import { listDepartments, ownAddresses } from "./departments";
import { type InboundResult, processInboundMessage } from "./inbound";
import { sendTicketConfirmation } from "./outbound";
import type { MailChannelConfig } from "./settings";

/**
 * The two ways a message reaches the pipeline, and why there are two.
 *
 * `drainNotifications` is the fast path: the webhook wrote a row, this
 * fetches the message it names. `reconcileMailbox` is the one that makes the
 * fast path optional — a delta query against the inbox, so a notification
 * that was never delivered, a subscription that lapsed over a weekend and a
 * webhook that answered 500 for an hour all cost latency and nothing else.
 *
 * Both end in `processInboundMessage`, which is where the claim is. Running
 * them at the same time on the same message is therefore not a race worth
 * avoiding: one of them files it and the other is told it is a duplicate.
 */

type Db = typeof defaultDb;

export type SweepReport = {
    notifications: { handled: number; failed: number };
    delta: { mailbox: string; fetched: number; deltaAdvanced: boolean }[];
    results: Record<string, number>;
    confirmations: number;
    failures: { stage: string; detail: string }[];
};

function emptyReport(): SweepReport {
    return {
        notifications: { handled: 0, failed: 0 },
        delta: [],
        results: {},
        confirmations: 0,
        failures: [],
    };
}

function count(report: SweepReport, result: InboundResult) {
    const key =
        result.kind === "ignored"
            ? `ignored:${result.reason}`
            : result.kind === "filed"
              ? result.createdTicket
                  ? "filed:new"
                  : "filed:reply"
              : result.kind;

    report.results[key] = (report.results[key] ?? 0) + 1;

    /**
     * An attachment the pipeline could not keep was being returned and
     * dropped on the floor — nobody was told. It is the operator's business:
     * the customer thinks they sent us the logfile.
     */
    if (result.kind === "filed") {
        for (const skipped of result.skippedAttachments) {
            const reason = `attachment:${skipped.reason}`;

            report.results[reason] = (report.results[reason] ?? 0) + 1;
        }
    }
}

export type SweepContext = {
    channel: MailChannel;
    config: MailChannelConfig;
};

/**
 * Processes one message id and, when it opened a ticket, sends the
 * acknowledgement.
 *
 * The acknowledgement is deliberately outside `processInboundMessage`: a
 * mail that fails to send must not be able to roll back the ticket it was
 * acknowledging, and a ticket that exists with no acknowledgement is a far
 * better state than an acknowledgement for a ticket that does not.
 */
export async function handleMessage(
    db: Db,
    context: SweepContext,
    mailbox: string,
    channelMessageId: string,
    own: readonly string[],
    report: SweepReport,
): Promise<InboundResult> {
    const result = await processInboundMessage(db, {
        channel: context.channel,
        mailbox,
        channelMessageId,
        ownAddresses: own,
        processedFolder: context.config.processedFolder,
        maxAttachmentBytes: context.config.maxAttachmentBytes,
    });

    count(report, result);

    if (result.kind === "filed" && result.createdTicket && !result.automated) {
        const confirmation = await sendTicketConfirmation(db, context.channel, {
            ticketId: result.ticketId,
            limitPerHour: context.config.autoReplyPerHour,
        });

        if (confirmation.sent) {
            report.confirmations += 1;
        }
    }

    return result;
}

export async function drainNotifications(
    db: Db,
    context: SweepContext,
    report: SweepReport = emptyReport(),
    limit = 50,
): Promise<SweepReport> {
    const pending = await pendingNotifications(db, limit);
    const own = await ownAddresses(db, [context.config.outboundSender]);

    for (const notification of pending) {
        try {
            await handleMessage(
                db,
                context,
                notification.mailbox,
                notification.resourceId,
                own,
                report,
            );

            await markNotificationHandled(db, notification.id);
            report.notifications.handled += 1;
        } catch (error) {
            /**
             * The row stays pending on purpose. A notification that failed
             * is work that has not happened, and the alternative — marking
             * it handled and relying on the delta sweep — is the mistake
             * `claimEvent` was written to avoid: a failure that reads as a
             * success.
             */
            await markNotificationFailed(db, notification.id, describe(error));
            report.notifications.failed += 1;
            report.failures.push({
                stage: `notification:${notification.resourceId.slice(0, 16)}`,
                detail: describe(error),
            });
        }
    }

    return report;
}

export async function reconcileMailbox(
    db: Db,
    context: SweepContext,
    mailbox: string,
    report: SweepReport = emptyReport(),
): Promise<SweepReport> {
    const own = await ownAddresses(db, [context.config.outboundSender]);

    const [state] = await db
        .select()
        .from(schema.mailboxState)
        .where(eq(schema.mailboxState.mailbox, mailbox))
        .limit(1);

    let page: Awaited<ReturnType<MailChannel["listDelta"]>>;

    try {
        page = await context.channel.listDelta(
            mailbox,
            state?.deltaLink ?? null,
        );
    } catch (error) {
        /**
         * A delta link Graph no longer accepts (410 Gone — it keeps them for
         * about 30 days) is cleared so the next pass starts a fresh delta.
         * Keeping it would mean the mailbox is never reconciled again, which
         * is the quiet failure this whole function exists to prevent.
         */
        if ((error as { status?: number })?.status === 410) {
            await saveDelta(db, mailbox, null);
        }

        report.failures.push({
            stage: `delta:${mailbox}`,
            detail: describe(error),
        });

        return report;
    }

    let failed = 0;

    for (const id of page.messageIds) {
        try {
            await handleMessage(db, context, mailbox, id, own, report);
        } catch (error) {
            failed += 1;
            report.failures.push({
                stage: `message:${id.slice(0, 16)}`,
                detail: describe(error),
            });
        }
    }

    /**
     * **The cursor only moves past mail that was actually dealt with.**
     *
     * A delta token says "you have seen everything up to here", and Graph
     * takes that at its word: a message already reported is not reported
     * again. So advancing over a message whose pass threw is not a retry
     * postponed, it is a mail silently gone — and the message that threw is
     * usually the one that was never claimed at all, because the fetch is
     * the first thing `processInboundMessage` does and the claim is the
     * second. Nothing reads an open `inbound_mail` row back either. There
     * is no second chance anywhere; this is it.
     *
     * Holding the cursor makes the delta path behave the way the
     * notification path already does — the row stays pending, the next pass
     * is a real retry — and re-walking is free of consequence because the
     * claim and the unique index make every message past the first a no-op.
     * What it costs is that a message which fails for ever holds its
     * mailbox's place: loud (it is in `failures` and on the admin page, and
     * the mailbox stops advancing) rather than quiet, which is the trade
     * this system makes everywhere else.
     */
    if (page.deltaLink && failed === 0) {
        await saveDelta(db, mailbox, page.deltaLink);
    }

    report.delta.push({
        mailbox,
        fetched: page.messageIds.length,
        // What happened, not what was on offer.
        deltaAdvanced: Boolean(page.deltaLink) && failed === 0,
    });

    return report;
}

async function saveDelta(
    db: Db,
    mailbox: string,
    deltaLink: string | null,
): Promise<void> {
    await db
        .insert(schema.mailboxState)
        .values({ mailbox, deltaLink, deltaAt: new Date() })
        .onConflictDoUpdate({
            target: schema.mailboxState.mailbox,
            set: { deltaLink, deltaAt: new Date(), updatedAt: new Date() },
        });
}

/** Everything the cron does: drain what was notified, then reconcile. */
export async function sweepMailboxes(
    db: Db,
    context: SweepContext,
    options: { reconcile?: boolean } = {},
): Promise<SweepReport> {
    const report = emptyReport();

    await drainNotifications(db, context, report);

    if (options.reconcile === false) {
        return report;
    }

    const departments = await listDepartments(db, { activeOnly: true });
    const mailboxes = [
        ...new Set(
            departments
                .filter((row) => row.channel === context.channel.id)
                .map((row) => row.mailbox.toLowerCase()),
        ),
    ];

    for (const mailbox of mailboxes) {
        await reconcileMailbox(db, context, mailbox, report);
    }

    return report;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
