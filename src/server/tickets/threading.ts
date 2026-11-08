import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { Ticket } from "@/db/schema";
import type { InboundMessage } from "./channels/types";
import { header, normalizeMessageId, parseMessageIds } from "./headers";
import { parseTicketNumber } from "./numbering";

type Executor = Pick<typeof defaultDb, "select">;

export type ThreadMatch =
    | { kind: "ticket"; ticket: Ticket; matchedBy: ThreadSignal }
    | { kind: "new" };

export type ThreadSignal = "subject-tag" | "message-id" | "conversation";

/**
 * Which ticket an inbound message belongs to.
 *
 * Three signals, strongest first, and they are tried in that order because
 * they are not equally good:
 *
 *  1. **`[TKT-00042]` in the subject.** The one signal that survives a reply
 *     sent from a different address, a forward, and a client that drops
 *     every threading header. The number is never reused, which is what
 *     makes it safe to lead with.
 *  2. **`In-Reply-To` / `References` against the ids we stored.** Exact, and
 *     unforgeable in practice — the id has to be one we minted or one we
 *     received. It is second only because a client that strips the subject
 *     tag is rarer than one that strips these.
 *  3. **The channel's `conversationId`.** Scoped to the mailbox it came from
 *     and only used when the other two say nothing, because Exchange will
 *     happily put two unrelated messages with the same subject into one
 *     conversation.
 *
 * A ticket that has been merged away resolves to the ticket it was merged
 * into: the number stays valid for ever, which is the whole point of merging
 * rather than deleting.
 */
export async function resolveThread(
    db: Executor,
    message: InboundMessage,
    mailbox: string,
): Promise<ThreadMatch> {
    const number = parseTicketNumber(message.subject);

    if (number !== null) {
        const found = await followMerge(db, await byNumber(db, number));

        if (found) {
            return { kind: "ticket", ticket: found, matchedBy: "subject-tag" };
        }
    }

    const referenced = [
        ...parseMessageIds(header(message.headers, "in-reply-to")),
        ...parseMessageIds(header(message.headers, "references")),
    ];

    if (referenced.length > 0) {
        const [row] = await db
            .select({ ticketId: schema.ticketMessage.ticketId })
            .from(schema.ticketMessage)
            .where(inArray(schema.ticketMessage.internetMessageId, referenced))
            /**
             * The newest match: a long thread references every message in
             * it, and the most recent one says where the conversation is
             * now. The ULID is the tiebreaker, because two messages can
             * easily carry the same `sentAt` — a forward quoting both, or a
             * provider that reports whole seconds — and an arbitrary winner
             * would file the reply onto whichever ticket the index happened
             * to return first.
             */
            .orderBy(
                sql`${schema.ticketMessage.sentAt} desc, ${schema.ticketMessage.id} desc`,
            )
            .limit(1);

        if (row) {
            const found = await followMerge(db, await byId(db, row.ticketId));

            if (found) {
                return {
                    kind: "ticket",
                    ticket: found,
                    matchedBy: "message-id",
                };
            }
        }
    }

    if (message.conversationId) {
        const [row] = await db
            .select()
            .from(schema.ticket)
            .innerJoin(
                schema.ticketDepartment,
                eq(schema.ticket.departmentId, schema.ticketDepartment.id),
            )
            .where(
                and(
                    eq(schema.ticket.conversationId, message.conversationId),
                    eq(schema.ticketDepartment.mailbox, mailbox.toLowerCase()),
                ),
            )
            .orderBy(sql`${schema.ticket.lastMessageAt} desc`)
            .limit(1);

        /**
         * Through the merge like the other two branches, not around it. A
         * conversation whose ticket has been merged away belongs to the
         * ticket it was merged into — filing it onto the closed source
         * instead would hide the customer's reply in a ticket nobody reads.
         */
        const found = await followMerge(db, row?.ticket ?? null);

        if (found) {
            return {
                kind: "ticket",
                ticket: found,
                matchedBy: "conversation",
            };
        }
    }

    return { kind: "new" };
}

async function byNumber(db: Executor, number: number): Promise<Ticket | null> {
    const [row] = await db
        .select()
        .from(schema.ticket)
        .where(eq(schema.ticket.number, number))
        .limit(1);

    return row ?? null;
}

async function byId(db: Executor, id: string): Promise<Ticket | null> {
    const [row] = await db
        .select()
        .from(schema.ticket)
        .where(eq(schema.ticket.id, id))
        .limit(1);

    return row ?? null;
}

/**
 * Follows `merged_into_ticket_id` to the ticket that actually holds the
 * conversation. Bounded, because a cycle in that pointer would otherwise
 * hang the pipeline — `mergeTickets` refuses to make one, and this does not
 * depend on it having succeeded.
 */
async function followMerge(
    db: Executor,
    ticket: Ticket | null,
): Promise<Ticket | null> {
    let current = ticket;

    for (let depth = 0; current?.mergedIntoTicketId && depth < 10; depth += 1) {
        current = await byId(db, current.mergedIntoTicketId);
    }

    return current?.mergedIntoTicketId ? null : current;
}

export type ContactMatch = {
    customerId: string;
    contactId: string;
} | null;

/**
 * Which account an address belongs to.
 *
 * Against `customer_contact.email` — the address the account says it is
 * reached at — and never against the login address, which is a different
 * field that a customer may change without telling us. Case-insensitive,
 * because nothing about an address's local part is in practice.
 *
 * An address on two accounts (a Steuerberater) resolves to the one where
 * they are the owner, and otherwise to the oldest — deterministically
 * either way, so the same mail does not land on a different account twice.
 */
export async function matchContact(
    db: Executor,
    email: string | null | undefined,
): Promise<ContactMatch> {
    const address = email?.trim().toLowerCase();

    if (!address) {
        return null;
    }

    const rows = await db
        .select({
            customerId: schema.customerContact.customerId,
            contactId: schema.customerContact.id,
            role: schema.customerContact.role,
        })
        .from(schema.customerContact)
        .innerJoin(
            schema.customer,
            eq(schema.customerContact.customerId, schema.customer.id),
        )
        .where(
            and(
                sql`lower(${schema.customerContact.email}) = ${address}`,
                isNull(schema.customer.deletedAt),
            ),
        )
        .orderBy(schema.customerContact.id);

    const owner = rows.find((row) => row.role === "owner");
    const match = owner ?? rows[0];

    return match
        ? { customerId: match.customerId, contactId: match.contactId }
        : null;
}

/**
 * Whether we have a record of having sent this exact message.
 *
 * The strongest half of the loop protection: our own outbound copy coming
 * back — because the mailbox is on a distribution list, or because somebody
 * replied-all — carries the Message-ID Exchange gave the draft, which is the
 * one we stored when we sent it.
 */
export async function isOwnOutbound(
    db: Executor,
    internetMessageId: string | null,
): Promise<boolean> {
    const id = normalizeMessageId(internetMessageId);

    if (!id) {
        return false;
    }

    const [row] = await db
        .select({ id: schema.ticketMessage.id })
        .from(schema.ticketMessage)
        .where(
            and(
                eq(schema.ticketMessage.internetMessageId, id),
                or(
                    eq(schema.ticketMessage.direction, "outbound"),
                    eq(schema.ticketMessage.direction, "note"),
                ),
            ),
        )
        .limit(1);

    return Boolean(row);
}
