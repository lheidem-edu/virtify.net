import "server-only";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { Ticket } from "@/db/schema";
import { type Actor, audit } from "@/server/audit";
import { escapeHtml } from "@/server/mail";
import { readAttachment } from "./attachments";
import type { MailAddress, MailChannel } from "./channels/types";
import { claimAutoReply, releaseAutoReply } from "./claim";
import { departmentById } from "./departments";
import { normalizeMessageId } from "./headers";
import { subjectWithTag, ticketTag } from "./numbering";
import { TicketError } from "./service";

/**
 * Replies, and the one rule that governs where they go.
 *
 * **A reply goes to the people the ticket already knows about.** Not to
 * whoever sent the last message: a ticket is threaded by a number that
 * travels on a subject line, so anybody who learns that number can post
 * into the conversation — and a reply that went straight back to them would
 * turn a guessable number into a way of reading somebody else's support
 * history. The recipients are the requester plus the senders of inbound
 * messages that matched a contact of this ticket's account, and nobody
 * else. A stray sender is filed, flagged (`ticket.unknown_sender`) and
 * shown to staff, who can link the account if it really is one.
 */

type Db = typeof defaultDb;

export type ReplyInput = {
    ticketId: string;
    body: string;
    /** Extra recipients a member of staff typed. Validated, never implied. */
    cc?: string[];
    attachmentIds?: string[];
    /** Closes the ticket as the reply goes out. */
    closeTicket?: boolean;
    authorName?: string | null;
};

export type ReplyResult = {
    messageId: string;
    internetMessageId: string | null;
    delivered: boolean;
    recipients: string[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who a reply to this ticket goes to.
 *
 * Exported because it is the security-relevant half of the module and the
 * one thing worth asserting on its own.
 */
export async function replyRecipients(
    db: Pick<Db, "select">,
    ticket: Ticket,
): Promise<MailAddress[]> {
    const known = new Map<string, MailAddress>();

    const requester = ticket.requesterEmail.trim().toLowerCase();

    if (EMAIL.test(requester)) {
        known.set(requester, {
            email: requester,
            name: ticket.requesterName ?? null,
        });
    }

    if (ticket.customerId) {
        const contacts = await db
            .select({
                email: schema.customerContact.email,
            })
            .from(schema.customerContact)
            .where(eq(schema.customerContact.customerId, ticket.customerId));

        const allowed = new Set(
            contacts.map((row) => row.email.trim().toLowerCase()),
        );

        const participants = await db
            .select({
                email: schema.ticketMessage.authorEmail,
                name: schema.ticketMessage.authorName,
            })
            .from(schema.ticketMessage)
            .where(
                and(
                    eq(schema.ticketMessage.ticketId, ticket.id),
                    eq(schema.ticketMessage.direction, "inbound"),
                    isNotNull(schema.ticketMessage.authorEmail),
                ),
            );

        for (const row of participants) {
            const email = row.email?.trim().toLowerCase();

            if (email && allowed.has(email) && !known.has(email)) {
                known.set(email, { email, name: row.name });
            }
        }
    }

    return [...known.values()];
}

/** The quoted history we attach to an outbound reply, marked as ours. */
function quotedHistory(previous: { html: string; when: Date; who: string }) {
    return [
        '<div data-virtify-quote="1" style="border-left:3px solid #d4d4d8;margin:16px 0 0;padding:0 0 0 12px;color:#52525b;">',
        `<p style="font:400 12px/1.5 sans-serif;color:#a1a1aa;">Am ${previous.when.toLocaleString(
            "de-DE",
            { timeZone: "Europe/Berlin" },
        )} schrieb ${escapeHtml(previous.who)}:</p>`,
        previous.html,
        "</div>",
    ].join("");
}

/**
 * Sends a staff reply through the ticket's channel and records it.
 *
 * The record is written **after** the send, with the Message-ID the channel
 * reports — and that is the direction that matters: a reply recorded but
 * never sent is a customer waiting for an answer that exists only in our
 * database, while a reply sent but not recorded is picked up as inbound on
 * the next pass and filed against the ticket anyway. Only one of those two
 * failures is recoverable without anybody noticing.
 */
export async function replyToTicket(
    db: Db,
    channel: MailChannel,
    input: ReplyInput,
    actor: Actor,
): Promise<ReplyResult> {
    const body = input.body.trim();

    if (body === "") {
        throw new TicketError("Eine Antwort darf nicht leer sein.");
    }

    const [ticket] = await db
        .select()
        .from(schema.ticket)
        .where(eq(schema.ticket.id, input.ticketId))
        .limit(1);

    if (!ticket) {
        throw new TicketError("Das Ticket gibt es nicht.");
    }

    if (ticket.mergedIntoTicketId) {
        throw new TicketError(
            "Dieses Ticket wurde zusammengeführt; antworte im Ziel-Ticket.",
        );
    }

    const department = await departmentById(db, ticket.departmentId);

    if (!department) {
        throw new TicketError("Die Abteilung des Tickets gibt es nicht mehr.");
    }

    const to = await replyRecipients(db, ticket);

    if (to.length === 0) {
        throw new TicketError(
            "Zu diesem Ticket ist keine Empfängeradresse bekannt.",
        );
    }

    const cc = (input.cc ?? [])
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => EMAIL.test(entry))
        .filter((entry) => !to.some((address) => address.email === entry))
        .map((email) => ({ email, name: null }));

    // The newest inbound message is what we reply *to*, so the provider
    // keeps the thread together on the customer's side as well as ours.
    const [last] = await db
        .select()
        .from(schema.ticketMessage)
        .where(
            and(
                eq(schema.ticketMessage.ticketId, ticket.id),
                eq(schema.ticketMessage.direction, "inbound"),
            ),
        )
        .orderBy(desc(schema.ticketMessage.sentAt))
        .limit(1);

    const html = [
        `<div>${textToHtml(body)}</div>`,
        last?.displayHtml || last?.displayText
            ? quotedHistory({
                  html:
                      last.displayHtml ??
                      `<pre style="white-space:pre-wrap;font:inherit;">${escapeHtml(
                          last.displayText,
                      )}</pre>`,
                  when: last.sentAt,
                  who: last.authorEmail ?? ticket.requesterEmail,
              })
            : "",
    ].join("");

    const attachments = [];

    for (const id of input.attachmentIds ?? []) {
        const found = await readAttachment(db, id);

        if (found) {
            attachments.push({
                filename: found.row.filename,
                contentType: found.row.contentType,
                content: found.bytes,
            });
        }
    }

    const subject = subjectWithTag(ticket.number, ticket.subject);

    const sent = await channel.send(department.mailbox, {
        to,
        cc,
        subject,
        html,
        text: body,
        attachments,
        replyToChannelMessageId: last?.channelMessageId ?? null,
        inReplyTo: last?.internetMessageId ?? null,
        references: last?.references ?? [],
    });

    const internetMessageId = normalizeMessageId(sent.internetMessageId);

    return db.transaction(async (tx) => {
        const [message] = await tx
            .insert(schema.ticketMessage)
            .values({
                ticketId: ticket.id,
                direction: "outbound",
                authorType: "staff",
                authorId: actor.id ?? null,
                authorName: input.authorName ?? actor.label ?? null,
                authorEmail: department.mailbox,
                subject,
                toAddresses: to,
                ccAddresses: cc,
                displayText: body,
                displayHtml: `<div>${textToHtml(body)}</div>`,
                originalHtml: html,
                originalText: body,
                internetMessageId,
                inReplyTo: last?.internetMessageId ?? null,
                references: last?.internetMessageId
                    ? [...(last.references ?? []), last.internetMessageId]
                    : (last?.references ?? []),
                channelMessageId: sent.channelMessageId,
                conversationId: sent.conversationId ?? ticket.conversationId,
                sentAt: new Date(),
            })
            .returning({ id: schema.ticketMessage.id });

        await tx
            .update(schema.ticket)
            .set({
                status: input.closeTicket ? "closed" : "waiting",
                closedAt: input.closeTicket ? new Date() : null,
                firstResponseAt: ticket.firstResponseAt ?? new Date(),
                lastMessageAt: new Date(),
                conversationId:
                    ticket.conversationId ?? sent.conversationId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(schema.ticket.id, ticket.id));

        await audit(tx, {
            actor,
            action: "ticket.reply",
            entityType: "ticket",
            entityId: ticket.id,
            after: {
                to: to.map((address) => address.email),
                cc: cc.map((address) => address.email),
                closed: Boolean(input.closeTicket),
                internetMessageId,
            },
        });

        return {
            messageId: message.id,
            internetMessageId,
            delivered: true,
            recipients: to.map((address) => address.email),
        };
    });
}

/**
 * The "wir haben Ihre Anfrage erhalten" mail.
 *
 * Claimed against the sender's hourly budget **before** it is sent, because
 * a budget checked afterwards is not a budget — and given back if the send
 * then fails, which is the other direction of the same rule. Never sent to
 * anything that looked automatic: an out-of-office answered by an
 * acknowledgement answered by an out-of-office is the loop this phase
 * exists to not have.
 */
export async function sendTicketConfirmation(
    db: Db,
    channel: MailChannel,
    input: {
        ticketId: string;
        limitPerHour: number;
        now?: Date;
    },
): Promise<{ sent: boolean; reason?: string }> {
    const now = input.now ?? new Date();

    const [ticket] = await db
        .select()
        .from(schema.ticket)
        .where(eq(schema.ticket.id, input.ticketId))
        .limit(1);

    if (!ticket) {
        return { sent: false, reason: "no-ticket" };
    }

    const department = await departmentById(db, ticket.departmentId);

    if (!department) {
        return { sent: false, reason: "no-department" };
    }

    const recipient = ticket.requesterEmail.trim().toLowerCase();

    if (!EMAIL.test(recipient)) {
        return { sent: false, reason: "no-recipient" };
    }

    if (!(await claimAutoReply(db, recipient, input.limitPerHour, now))) {
        return { sent: false, reason: "rate-limited" };
    }

    const subject = subjectWithTag(ticket.number, ticket.subject);
    const tag = ticketTag(ticket.number);

    const text = [
        "Guten Tag,",
        "",
        `vielen Dank für Ihre Nachricht. Wir haben sie unter ${tag} erfasst und melden uns.`,
        "",
        "Bitte lassen Sie die Kennzeichnung im Betreff stehen, wenn Sie antworten — daran erkennen wir, worum es geht.",
        "",
        "Mit freundlichen Grüßen",
        department.name,
    ].join("\n");

    try {
        const sent = await channel.send(department.mailbox, {
            to: [{ email: recipient, name: ticket.requesterName }],
            subject,
            html: `<div>${textToHtml(text)}</div>`,
            text,
        });

        await db.insert(schema.ticketMessage).values({
            ticketId: ticket.id,
            direction: "outbound",
            authorType: "system",
            authorEmail: department.mailbox,
            subject,
            toAddresses: [{ email: recipient, name: ticket.requesterName }],
            displayText: text,
            originalText: text,
            internetMessageId: normalizeMessageId(sent.internetMessageId),
            channelMessageId: sent.channelMessageId,
            conversationId: sent.conversationId,
            isAutomated: true,
            sentAt: new Date(),
        });

        return { sent: true };
    } catch (error) {
        // The allowance was claimed for a mail that never went out.
        await releaseAutoReply(db, recipient, now);

        console.error(
            "[tickets] the confirmation for",
            ticket.number,
            "could not be sent:",
            error,
        );

        return { sent: false, reason: "send-failed" };
    }
}

/** Plain text to the HTML half of a mail. Escaped first, then line breaks. */
export function textToHtml(value: string): string {
    return escapeHtml(value)
        .split(/\n{2,}/)
        .map(
            (paragraph) =>
                `<p style="margin:0 0 12px;">${paragraph.replace(/\n/g, "<br />")}</p>`,
        )
        .join("");
}
