import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";

/**
 * Claiming work before doing it.
 *
 * The shape is `claimEvent()` in `src/server/payments/webhook-log.ts`, and
 * for the same reason: a row that is merely *looked up* turns a handler that
 * died halfway into a delivery the provider thinks succeeded. So the claim
 * is one statement — insert, or take the row back if nobody has finished it
 * — and `handled_at` is set only by a handler that ran to the end.
 *
 * What each row speaks for, stated plainly, because Phase 6 shipped two
 * defects that were exactly this question answered carelessly:
 *
 *  - `inbound_mail (mailbox, internet_message_id)` speaks for **one email
 *    message in one mailbox**. Not a notification, not a delta page, not a
 *    sweep: the message itself. That is why the key is the RFC 5322
 *    Message-ID and not the provider's id — the provider's id changes the
 *    moment the message is moved, which is the last thing we do to it.
 *  - `mail_notification (mailbox, resource_id)` speaks for **one pending
 *    look at one message**, and is deliberately re-claimable: a second
 *    change to the same message deserves a second look.
 *
 * Neither is the safety net. The unique index on
 * `ticket_message.internet_message_id` is: a message becomes one ticket
 * message because the database says so, not because the pipeline remembered
 * to check.
 */

type Db = Pick<typeof defaultDb, "insert" | "update" | "select" | "delete">;

/**
 * A stable identity for a message that arrived without a Message-ID.
 *
 * Rare but real — some scanners and web forms omit it. The provider's id
 * cannot stand in, because it changes on a move, so the identity is derived
 * from what does not: the mailbox, the sender, the subject and the instant
 * it was received.
 */
export function syntheticMessageId(input: {
    mailbox: string;
    from: string | null;
    subject: string;
    receivedAt: Date;
}): string {
    const digest = createHash("sha256")
        .update(
            [
                input.mailbox.toLowerCase(),
                (input.from ?? "").toLowerCase(),
                input.subject,
                input.receivedAt.toISOString(),
            ].join("\u0000"),
        )
        .digest("hex")
        .slice(0, 32);

    return `<no-message-id.${digest}@virtify.invalid>`;
}

export type InboundClaim = {
    id: string;
    attempts: number;
};

/**
 * Claims one message. Returns null when somebody already finished it.
 */
export async function claimInboundMail(
    db: Db,
    input: {
        channel: string;
        mailbox: string;
        internetMessageId: string;
        channelMessageId: string | null;
        fromEmail: string | null;
        subject: string | null;
        receivedAt: Date | null;
    },
): Promise<InboundClaim | null> {
    const claimed = await db
        .insert(schema.inboundMail)
        .values({
            channel: input.channel,
            mailbox: input.mailbox.toLowerCase(),
            internetMessageId: input.internetMessageId,
            channelMessageId: input.channelMessageId,
            fromEmail: input.fromEmail,
            subject: input.subject,
            receivedAt: input.receivedAt,
            attempts: 1,
        })
        .onConflictDoUpdate({
            target: [
                schema.inboundMail.mailbox,
                schema.inboundMail.internetMessageId,
            ],
            set: {
                attempts: sql`${schema.inboundMail.attempts} + 1`,
                channelMessageId: input.channelMessageId,
                updatedAt: new Date(),
            },
            // Only a message nobody has finished may be claimed again.
            setWhere: isNull(schema.inboundMail.handledAt),
        })
        .returning({
            id: schema.inboundMail.id,
            attempts: schema.inboundMail.attempts,
        });

    return claimed[0] ?? null;
}

export async function markInboundHandled(
    db: Db,
    id: string,
    result: {
        outcome: string;
        reason?: string | null;
        ticketId?: string | null;
        ticketMessageId?: string | null;
        channelMessageId?: string | null;
    },
): Promise<void> {
    await db
        .update(schema.inboundMail)
        .set({
            handledAt: new Date(),
            outcome: result.outcome,
            reason: result.reason ?? null,
            ticketId: result.ticketId ?? null,
            ticketMessageId: result.ticketMessageId ?? null,
            ...(result.channelMessageId
                ? { channelMessageId: result.channelMessageId }
                : {}),
            updatedAt: new Date(),
        })
        .where(eq(schema.inboundMail.id, id));
}

/** Records a notification. The route does this and nothing else. */
export async function recordNotification(
    db: Db,
    input: {
        channel: string;
        mailbox: string;
        subscriptionId: string;
        resourceId: string;
        changeType: string;
    },
): Promise<void> {
    await db
        .insert(schema.mailNotification)
        .values({
            channel: input.channel,
            mailbox: input.mailbox.toLowerCase(),
            subscriptionId: input.subscriptionId,
            resourceId: input.resourceId,
            changeType: input.changeType,
            receivedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: [
                schema.mailNotification.mailbox,
                schema.mailNotification.resourceId,
            ],
            // A later change to the same message is a new reason to look,
            // so the row is reopened rather than ignored. The message-level
            // claim is what keeps that from doing the work twice.
            set: {
                handledAt: null,
                changeType: input.changeType,
                subscriptionId: input.subscriptionId,
                receivedAt: new Date(),
                updatedAt: new Date(),
            },
        });
}

export async function pendingNotifications(
    db: Db,
    limit = 50,
): Promise<(typeof schema.mailNotification.$inferSelect)[]> {
    return db
        .select()
        .from(schema.mailNotification)
        .where(isNull(schema.mailNotification.handledAt))
        .orderBy(asc(schema.mailNotification.receivedAt))
        .limit(limit);
}

export async function markNotificationHandled(
    db: Db,
    id: string,
    error?: string | null,
): Promise<void> {
    await db
        .update(schema.mailNotification)
        .set({
            handledAt: new Date(),
            attempts: sql`${schema.mailNotification.attempts} + 1`,
            lastError: error ?? null,
            updatedAt: new Date(),
        })
        .where(eq(schema.mailNotification.id, id));
}

/** A notification that failed stays pending, with the failure recorded. */
export async function markNotificationFailed(
    db: Db,
    id: string,
    error: string,
): Promise<void> {
    await db
        .update(schema.mailNotification)
        .set({
            attempts: sql`${schema.mailNotification.attempts} + 1`,
            lastError: error.slice(0, 500),
            updatedAt: new Date(),
        })
        .where(eq(schema.mailNotification.id, id));
}

/** Notifications that have been handled for a while are of no further use. */
export async function pruneNotifications(
    db: Db,
    before: Date,
): Promise<number> {
    const removed = await db
        .delete(schema.mailNotification)
        .where(lt(schema.mailNotification.handledAt, before))
        .returning({ id: schema.mailNotification.id });

    return removed.length;
}

/** The hour a budget row belongs to, in UTC. */
export function autoReplyWindow(at: Date): string {
    return at.toISOString().slice(0, 13);
}

/**
 * Claims one automatic reply to `recipient`.
 *
 * The budget is the database's answer, not a count somebody read a moment
 * ago: the conditional update is what makes two workers racing on the same
 * angry autoresponder send one reply between them rather than two.
 *
 * Returns false when the sender has had their allowance this hour.
 */
export async function claimAutoReply(
    db: Db,
    recipient: string,
    limitPerHour: number,
    at: Date = new Date(),
): Promise<boolean> {
    if (limitPerHour <= 0) {
        return false;
    }

    const claimed = await db
        .insert(schema.autoReplyBudget)
        .values({
            recipient: recipient.trim().toLowerCase(),
            window: autoReplyWindow(at),
            count: 1,
        })
        .onConflictDoUpdate({
            target: [
                schema.autoReplyBudget.recipient,
                schema.autoReplyBudget.window,
            ],
            set: {
                count: sql`${schema.autoReplyBudget.count} + 1`,
                updatedAt: new Date(),
            },
            setWhere: lt(schema.autoReplyBudget.count, limitPerHour),
        })
        .returning({ count: schema.autoReplyBudget.count });

    return claimed.length > 0;
}

/**
 * Gives back an allowance that was claimed for a reply that never went out.
 *
 * The other direction of `claimAutoReply`, and it exists because the claim
 * has to happen *before* the send — a budget checked afterwards is no budget
 * at all. A send that then fails would otherwise cost the sender an
 * allowance they never received anything for.
 */
export async function releaseAutoReply(
    db: Db,
    recipient: string,
    at: Date = new Date(),
): Promise<void> {
    await db
        .update(schema.autoReplyBudget)
        .set({
            count: sql`greatest(${schema.autoReplyBudget.count} - 1, 0)`,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(
                    schema.autoReplyBudget.recipient,
                    recipient.trim().toLowerCase(),
                ),
                eq(schema.autoReplyBudget.window, autoReplyWindow(at)),
            ),
        );
}
