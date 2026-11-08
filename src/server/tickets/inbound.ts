import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { Ticket, TicketDepartment } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { audit } from "@/server/audit";
import {
    downloadAttachments,
    removeOrphans,
    type SkippedAttachment,
} from "./attachments";
import type { InboundMessage, MailChannel } from "./channels/types";
import {
    claimInboundMail,
    markInboundHandled,
    syntheticMessageId,
} from "./claim";
import { header, normalizeMessageId, parseMessageIds } from "./headers";
import { classifyInbound, type IgnoreReason } from "./loop";
import { nextTicketNumber } from "./numbering";
import { prepareBody } from "./quoting";
import type { ThreadSignal } from "./threading";
import { isOwnOutbound, matchContact, resolveThread } from "./threading";

/**
 * One email message, from the mailbox to a ticket.
 *
 * Every route into this system goes through here — the webhook's
 * notification, the five-minute delta reconciliation and the operator's
 * "jetzt abholen" button alike — because a second path would be a second
 * answer to "has this message already been filed", and the one that was
 * wrong would be the one that filed it twice.
 *
 * The order matters and is deliberate:
 *
 *   1. fetch the message **from the provider**. Nothing in a notification is
 *      trusted to say what arrived; the notification names a message in a
 *      mailbox we already know about, and that is all it is allowed to do.
 *   2. claim it — `inbound_mail (mailbox, internet_message_id)`.
 *   3. decide whether it may become a ticket message at all (loop
 *      protection), *before* anything is written or sent.
 *   4. thread it, match the sender, fetch the attachments.
 *   5. write the ticket and the message in one transaction, under the unique
 *      index on `ticket_message.internet_message_id`, which is what actually
 *      guarantees one mail becomes one message.
 *   6. mark it read and move it out of the inbox.
 *   7. only then mark the claim handled.
 *
 * A failure anywhere before 7 leaves the claim open, so the next pass is a
 * real retry — and the unique index means that retry cannot double anything
 * the first attempt did manage to write.
 */

type Db = typeof defaultDb;

export type InboundResult =
    | {
          kind: "filed";
          ticketId: string;
          ticketNumber: number;
          ticketMessageId: string;
          createdTicket: boolean;
          matchedBy: ThreadSignal | "new";
          automated: boolean;
          unknownSender: boolean;
          skippedAttachments: SkippedAttachment[];
      }
    | { kind: "ignored"; reason: IgnoreReason }
    | { kind: "duplicate"; ticketId: string | null }
    | { kind: "gone" }
    | { kind: "no-department" };

export type InboundOptions = {
    channel: MailChannel;
    mailbox: string;
    channelMessageId: string;
    /** Every address this installation sends from. */
    ownAddresses: readonly string[];
    processedFolder: string;
    maxAttachmentBytes: number;
};

export async function processInboundMessage(
    db: Db,
    options: InboundOptions,
): Promise<InboundResult> {
    const mailbox = options.mailbox.toLowerCase();

    const message = await options.channel.getMessage(
        mailbox,
        options.channelMessageId,
    );

    if (!message) {
        return { kind: "gone" };
    }

    const internetMessageId =
        normalizeMessageId(message.internetMessageId) ??
        syntheticMessageId({
            mailbox,
            from: message.from?.email ?? null,
            subject: message.subject,
            receivedAt: message.receivedAt,
        });

    const claim = await claimInboundMail(db, {
        channel: options.channel.id,
        mailbox,
        internetMessageId,
        channelMessageId: message.channelMessageId,
        fromEmail: message.from?.email ?? null,
        subject: message.subject,
        receivedAt: message.receivedAt,
    });

    if (!claim) {
        const [existing] = await db
            .select({ ticketId: schema.inboundMail.ticketId })
            .from(schema.inboundMail)
            .where(
                and(
                    eq(schema.inboundMail.mailbox, mailbox),
                    eq(schema.inboundMail.internetMessageId, internetMessageId),
                ),
            )
            .limit(1);

        return { kind: "duplicate", ticketId: existing?.ticketId ?? null };
    }

    const verdict = classifyInbound(message, {
        ownAddresses: options.ownAddresses,
        isOwnOutbound: await isOwnOutbound(db, internetMessageId),
    });

    if (verdict.kind === "ignore") {
        await finishWithProvider(options, message, mailbox);
        await markInboundHandled(db, claim.id, {
            outcome: "ignored",
            reason: verdict.reason,
        });

        return { kind: "ignored", reason: verdict.reason };
    }

    const department = await departmentFor(db, mailbox);

    if (!department) {
        // Nothing to file it against. The claim is *not* marked handled:
        // the operator creating the department is what should make the next
        // pass pick this up, rather than the message being lost to a row
        // that says it was dealt with.
        return { kind: "no-department" };
    }

    const thread = await resolveThread(db, message, mailbox);
    const contact = await matchContact(db, message.from?.email);
    const body = prepareBody({
        html: message.bodyHtml,
        text: message.bodyText,
    });

    // Ids are minted here so the attachment bytes can be written before the
    // transaction opens, under keys the rows will carry.
    const ticketId =
        thread.kind === "ticket" ? thread.ticket.id : createId("ticket");
    const ticketMessageId = createId("ticketmessage");

    const attachments = await downloadAttachments(
        options.channel,
        mailbox,
        message.channelMessageId,
        ticketId,
        ticketMessageId,
        message.attachments,
        {
            maxBytes: options.maxAttachmentBytes,
            createId: () => createId("ticketattachment"),
        },
    );

    const stored = attachments.filter((entry) => !entry.skipped);
    const skipped = attachments.filter(
        (entry): entry is SkippedAttachment => entry.skipped,
    );

    const references = [
        ...parseMessageIds(header(message.headers, "references")),
        ...parseMessageIds(header(message.headers, "in-reply-to")),
    ];
    const inReplyTo =
        parseMessageIds(header(message.headers, "in-reply-to"))[0] ?? null;

    try {
        const written = await db.transaction(async (tx) => {
            let ticket: Ticket;
            let createdTicket = false;

            if (thread.kind === "ticket") {
                // Locked for the duration: two replies to one ticket
                // arriving together must not both decide what its status is.
                const [locked] = await tx
                    .select()
                    .from(schema.ticket)
                    .where(eq(schema.ticket.id, ticketId))
                    .for("update")
                    .limit(1);

                if (!locked) {
                    throw new Error(
                        `ticket ${ticketId} disappeared while filing a message`,
                    );
                }

                ticket = locked;
            } else {
                const number = await nextTicketNumber(tx);

                [ticket] = await tx
                    .insert(schema.ticket)
                    .values({
                        id: ticketId,
                        number,
                        departmentId: department.id,
                        customerId: contact?.customerId ?? null,
                        contactId: contact?.contactId ?? null,
                        unknownSender: contact === null,
                        subject: message.subject || "(ohne Betreff)",
                        status: "open",
                        priority: "normal",
                        requesterEmail: message.from?.email ?? "",
                        requesterName: message.from?.name ?? null,
                        conversationId: message.conversationId,
                        lastMessageAt: message.receivedAt,
                    })
                    .returning();

                createdTicket = true;
            }

            const inserted = await tx
                .insert(schema.ticketMessage)
                .values({
                    id: ticketMessageId,
                    ticketId: ticket.id,
                    direction: "inbound",
                    authorType: contact ? "customer" : "system",
                    authorId: contact?.contactId ?? null,
                    authorName: message.from?.name ?? null,
                    authorEmail: message.from?.email ?? null,
                    subject: message.subject,
                    toAddresses: message.to,
                    ccAddresses: message.cc,
                    displayText: body.displayText,
                    displayHtml: body.displayHtml,
                    originalHtml: body.originalHtml,
                    originalText: body.originalText,
                    internetMessageId,
                    inReplyTo,
                    references,
                    channelMessageId: message.channelMessageId,
                    conversationId: message.conversationId,
                    isAutomated: verdict.automated,
                    sentAt: message.receivedAt,
                })
                /**
                 * The real guarantee. A retry that got past the claim — the
                 * process died between the commit and `markInboundHandled` —
                 * lands here and writes nothing.
                 */
                .onConflictDoNothing({
                    target: schema.ticketMessage.internetMessageId,
                })
                .returning({ id: schema.ticketMessage.id });

            if (inserted.length === 0) {
                return { duplicate: true as const, ticket, createdTicket };
            }

            if (stored.length > 0) {
                await tx.insert(schema.ticketAttachment).values(
                    stored.map((entry) => ({
                        id: entry.id,
                        messageId: ticketMessageId,
                        filename: entry.filename,
                        contentType: entry.contentType,
                        sizeBytes: entry.sizeBytes,
                        storageKey: entry.storageKey,
                        sha256: entry.sha256,
                        contentId: entry.contentId,
                        isInline: entry.isInline,
                    })),
                );
            }

            const unknownSender = ticket.unknownSender || contact === null;

            if (!createdTicket) {
                await tx
                    .update(schema.ticket)
                    .set({
                        /**
                         * A reply reopens a closed ticket. `on_hold` is the
                         * one status a customer's message does not move —
                         * it means somebody decided to park this, and a
                         * reminder mail should not undo that decision.
                         */
                        status:
                            ticket.status === "on_hold"
                                ? ticket.status
                                : "open",
                        lastMessageAt: message.receivedAt,
                        closedAt: null,
                        unknownSender,
                        conversationId:
                            ticket.conversationId ?? message.conversationId,
                        // A ticket that arrived from an unknown address and
                        // whose sender is now a known contact gets linked.
                        customerId:
                            ticket.customerId ?? contact?.customerId ?? null,
                        contactId:
                            ticket.contactId ?? contact?.contactId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.ticket.id, ticket.id));
            }

            await audit(tx, {
                actor: {
                    type: "system",
                    label: `channel:${options.channel.id}`,
                },
                action: createdTicket ? "ticket.create" : "ticket.message",
                entityType: "ticket",
                entityId: ticket.id,
                after: {
                    number: ticket.number,
                    from: message.from?.email ?? null,
                    matchedBy:
                        thread.kind === "ticket" ? thread.matchedBy : "new",
                    attachments: stored.length,
                    automated: verdict.automated,
                },
            });

            return { duplicate: false as const, ticket, createdTicket };
        });

        if (written.duplicate) {
            // Nothing was recorded, so the bytes this attempt wrote belong
            // to nobody. The way back from a write that was never recorded.
            await removeOrphans(stored.map((entry) => entry.storageKey));

            const newId = await finishWithProvider(options, message, mailbox);

            await markInboundHandled(db, claim.id, {
                outcome: "duplicate",
                ticketId: written.ticket.id,
                channelMessageId: newId,
            });

            return { kind: "duplicate", ticketId: written.ticket.id };
        }

        const newChannelId = await finishWithProvider(
            options,
            message,
            mailbox,
        );

        if (newChannelId) {
            await db
                .update(schema.ticketMessage)
                .set({ channelMessageId: newChannelId })
                .where(eq(schema.ticketMessage.id, ticketMessageId));
        }

        await markInboundHandled(db, claim.id, {
            outcome: "ticket",
            ticketId: written.ticket.id,
            ticketMessageId,
            channelMessageId: newChannelId,
        });

        return {
            kind: "filed",
            ticketId: written.ticket.id,
            ticketNumber: written.ticket.number,
            ticketMessageId,
            createdTicket: written.createdTicket,
            matchedBy: thread.kind === "ticket" ? thread.matchedBy : "new",
            automated: verdict.automated,
            unknownSender: contact === null,
            skippedAttachments: skipped,
        };
    } catch (error) {
        // The transaction rolled back, so these bytes belong to nobody.
        await removeOrphans(stored.map((entry) => entry.storageKey));

        throw error;
    }
}

async function departmentFor(
    db: Db,
    mailbox: string,
): Promise<TicketDepartment | null> {
    const [row] = await db
        .select()
        .from(schema.ticketDepartment)
        .where(eq(schema.ticketDepartment.mailbox, mailbox))
        .limit(1);

    return row ?? null;
}

/**
 * Marks the message read and moves it to the processed folder.
 *
 * Deliberately best-effort and deliberately *not* fatal: the message is
 * already a ticket by the time this runs, and a mailbox that refuses the
 * move must not make the pipeline file it a second time. What it costs when
 * it fails is a message left in the inbox, which the next delta pass sees
 * and the claim then skips.
 *
 * Returns the message's new provider id, because a move mints one.
 */
async function finishWithProvider(
    options: InboundOptions,
    message: InboundMessage,
    mailbox: string,
): Promise<string | null> {
    try {
        await options.channel.markRead(mailbox, message.channelMessageId);
    } catch (error) {
        console.error(
            "[tickets] could not mark a message read:",
            message.channelMessageId,
            error,
        );
    }

    try {
        return await options.channel.moveToFolder(
            mailbox,
            message.channelMessageId,
            options.processedFolder,
        );
    } catch (error) {
        console.error(
            "[tickets] could not move a message to the processed folder:",
            message.channelMessageId,
            error,
        );

        return null;
    }
}

/**
 * Puts a message back where it can be processed again.
 *
 * The other direction of the pipeline, and it exists because "processed"
 * is a claim this system makes about its own work and claims are sometimes
 * wrong — a department created after the fact, a stripping rule that ate
 * the message, a ticket deleted by mistake. Clearing the claim is all it
 * takes: the next pass fetches the message afresh and files it.
 */
export async function reopenInboundMail(
    db: Db,
    inboundMailId: string,
): Promise<boolean> {
    const updated = await db
        .update(schema.inboundMail)
        .set({
            handledAt: null,
            outcome: null,
            reason: null,
            updatedAt: new Date(),
        })
        .where(eq(schema.inboundMail.id, inboundMailId))
        .returning({ id: schema.inboundMail.id });

    return updated.length > 0;
}

/** How the inbound pipeline has been doing lately, for the admin area. */
export async function inboundStats(db: Db): Promise<{
    pending: number;
    ignored: number;
    filed: number;
}> {
    const [row] = await db
        .select({
            pending: sql<number>`count(*) filter (where ${schema.inboundMail.handledAt} is null)::int`,
            ignored: sql<number>`count(*) filter (where ${schema.inboundMail.outcome} = 'ignored')::int`,
            filed: sql<number>`count(*) filter (where ${schema.inboundMail.outcome} = 'ticket')::int`,
        })
        .from(schema.inboundMail);

    return row ?? { pending: 0, ignored: 0, filed: 0 };
}
