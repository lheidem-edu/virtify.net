import "server-only";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type {
    Ticket,
    TicketAttachment,
    TicketMessage,
    TicketPriority,
    TicketStatus,
} from "@/db/schema";

/**
 * Reading tickets, always with the question "who is asking" answered first.
 *
 * Hard rule 5 in its ticketing form: `customerId` is not a filter the caller
 * may leave off. `ANY_CUSTOMER` is the only way to read across accounts and
 * it is a deliberate, greppable thing to type — the admin pages and a staff
 * API key pass it, and nothing under `(client)` ever does.
 *
 * A ticket with **no** customer is staff-only, and that falls out of the
 * same rule: `customer_id = $1` cannot match a null, so an unmatched
 * sender's ticket is invisible to every customer, including the one whose
 * address it was sent from.
 */

export const ANY_CUSTOMER = Symbol("any-customer");
export type CustomerScope = string | typeof ANY_CUSTOMER;

type Executor = Pick<typeof defaultDb, "select">;

export type TicketFilters = {
    status?: TicketStatus | "open-ish";
    departmentId?: string;
    assigneeId?: string | null;
    priority?: TicketPriority;
    customerId?: string;
    unknownSenderOnly?: boolean;
    cursor?: string;
    limit?: number;
    /** Merged-away tickets are hidden from the queue by default. */
    includeMerged?: boolean;
};

export type TicketListRow = Ticket & {
    departmentName: string;
    customerName: string | null;
    assigneeName: string | null;
    messageCount: number;
};

const MAX_LIMIT = 100;

function scopeCondition(scope: CustomerScope) {
    return scope === ANY_CUSTOMER
        ? undefined
        : eq(schema.ticket.customerId, scope);
}

export async function listTickets(
    scope: CustomerScope,
    filters: TicketFilters,
    db: Executor,
): Promise<{
    rows: TicketListRow[];
    nextCursor: string | null;
    hasMore: boolean;
}> {
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), MAX_LIMIT);

    const conditions = [scopeCondition(scope)];

    if (!filters.includeMerged) {
        conditions.push(isNull(schema.ticket.mergedIntoTicketId));
    }

    if (filters.status === "open-ish") {
        conditions.push(
            inArray(schema.ticket.status, ["open", "waiting", "on_hold"]),
        );
    } else if (filters.status) {
        conditions.push(eq(schema.ticket.status, filters.status));
    }

    if (filters.departmentId) {
        conditions.push(eq(schema.ticket.departmentId, filters.departmentId));
    }

    if (filters.assigneeId === null) {
        conditions.push(isNull(schema.ticket.assigneeId));
    } else if (filters.assigneeId) {
        conditions.push(eq(schema.ticket.assigneeId, filters.assigneeId));
    }

    if (filters.priority) {
        conditions.push(eq(schema.ticket.priority, filters.priority));
    }

    if (scope === ANY_CUSTOMER && filters.customerId) {
        conditions.push(eq(schema.ticket.customerId, filters.customerId));
    }

    if (filters.unknownSenderOnly) {
        conditions.push(eq(schema.ticket.unknownSender, true));
    }

    if (filters.cursor) {
        // ULID cursor pagination, hard rule 1. Descending, because a queue
        // is read newest first.
        conditions.push(lt(schema.ticket.id, filters.cursor));
    }

    const rows = await db
        .select({
            ticket: schema.ticket,
            departmentName: schema.ticketDepartment.name,
            customerName: schema.customer.name,
            assigneeName: schema.staffUser.name,
            messageCount: sql<number>`(
                select count(*)::int from ${schema.ticketMessage}
                where ${schema.ticketMessage.ticketId} = ${schema.ticket.id}
            )`,
        })
        .from(schema.ticket)
        .innerJoin(
            schema.ticketDepartment,
            eq(schema.ticket.departmentId, schema.ticketDepartment.id),
        )
        .leftJoin(
            schema.customer,
            eq(schema.ticket.customerId, schema.customer.id),
        )
        .leftJoin(
            schema.staffUser,
            eq(schema.ticket.assigneeId, schema.staffUser.id),
        )
        .where(and(...conditions.filter(Boolean)))
        .orderBy(desc(schema.ticket.id))
        .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
        rows: page.map((row) => ({
            ...row.ticket,
            departmentName: row.departmentName,
            customerName: row.customerName,
            assigneeName: row.assigneeName,
            messageCount: row.messageCount,
        })),
        nextCursor: hasMore ? (page[page.length - 1]?.ticket.id ?? null) : null,
        hasMore,
    };
}

export type LoadedTicket = {
    ticket: Ticket;
    departmentName: string;
    customerName: string | null;
    assigneeName: string | null;
    messages: (TicketMessage & { attachments: TicketAttachment[] })[];
    /** Tickets that were merged into this one. */
    mergedIn: Ticket[];
};

/**
 * One ticket, or null.
 *
 * Null rather than a thrown refusal, because every caller turns it into a
 * 404 — telling a customer "403" about a ticket id would confirm the id
 * exists, which is the one thing a guessable number must never do.
 *
 * `includeNotes` is false for the customer: an internal note is staff-only
 * and it is filtered **here**, in the query, rather than in a component that
 * might one day be rendered by something else.
 */
export async function loadTicket(
    id: string,
    scope: CustomerScope,
    db: Executor,
    options: { includeNotes?: boolean; byNumber?: boolean } = {},
): Promise<LoadedTicket | null> {
    const conditions = [
        options.byNumber
            ? eq(schema.ticket.number, Number(id))
            : eq(schema.ticket.id, id),
        scopeCondition(scope),
    ].filter(Boolean);

    const [row] = await db
        .select({
            ticket: schema.ticket,
            departmentName: schema.ticketDepartment.name,
            customerName: schema.customer.name,
            assigneeName: schema.staffUser.name,
        })
        .from(schema.ticket)
        .innerJoin(
            schema.ticketDepartment,
            eq(schema.ticket.departmentId, schema.ticketDepartment.id),
        )
        .leftJoin(
            schema.customer,
            eq(schema.ticket.customerId, schema.customer.id),
        )
        .leftJoin(
            schema.staffUser,
            eq(schema.ticket.assigneeId, schema.staffUser.id),
        )
        .where(and(...conditions))
        .limit(1);

    if (!row) {
        return null;
    }

    const messages = await db
        .select()
        .from(schema.ticketMessage)
        .where(
            and(
                eq(schema.ticketMessage.ticketId, row.ticket.id),
                options.includeNotes
                    ? undefined
                    : or(
                          eq(schema.ticketMessage.direction, "inbound"),
                          eq(schema.ticketMessage.direction, "outbound"),
                      ),
            ),
        )
        .orderBy(
            asc(schema.ticketMessage.sentAt),
            asc(schema.ticketMessage.id),
        );

    const attachments =
        messages.length > 0
            ? await db
                  .select()
                  .from(schema.ticketAttachment)
                  .where(
                      inArray(
                          schema.ticketAttachment.messageId,
                          messages.map((message) => message.id),
                      ),
                  )
            : [];

    const mergedIn = await db
        .select()
        .from(schema.ticket)
        .where(eq(schema.ticket.mergedIntoTicketId, row.ticket.id))
        .orderBy(asc(schema.ticket.number));

    return {
        ticket: row.ticket,
        departmentName: row.departmentName,
        customerName: row.customerName,
        assigneeName: row.assigneeName,
        messages: messages.map((message) => ({
            ...message,
            attachments: attachments.filter(
                (entry) => entry.messageId === message.id,
            ),
        })),
        mergedIn,
    };
}

/**
 * Whether an attachment may be handed to this caller.
 *
 * The join that answers it is the whole point: an attachment is reachable
 * through its message, through its ticket, through that ticket's customer —
 * so a customer asking for an id that belongs to somebody else's ticket is
 * answered by the `where` clause rather than by a check somebody has to
 * remember to write.
 */
export async function attachmentInScope(
    attachmentId: string,
    scope: CustomerScope,
    db: Executor,
): Promise<boolean> {
    const [row] = await db
        .select({ id: schema.ticketAttachment.id })
        .from(schema.ticketAttachment)
        .innerJoin(
            schema.ticketMessage,
            eq(schema.ticketAttachment.messageId, schema.ticketMessage.id),
        )
        .innerJoin(
            schema.ticket,
            eq(schema.ticketMessage.ticketId, schema.ticket.id),
        )
        .where(
            and(
                eq(schema.ticketAttachment.id, attachmentId),
                scopeCondition(scope),
                // A customer never sees what is attached to an internal note.
                scope === ANY_CUSTOMER
                    ? undefined
                    : or(
                          eq(schema.ticketMessage.direction, "inbound"),
                          eq(schema.ticketMessage.direction, "outbound"),
                      ),
            ),
        )
        .limit(1);

    return Boolean(row);
}

export async function ticketCounts(db: Executor): Promise<{
    open: number;
    waiting: number;
    unassigned: number;
    unknownSender: number;
}> {
    const [row] = await db
        .select({
            open: sql<number>`count(*) filter (where ${schema.ticket.status} = 'open')::int`,
            waiting: sql<number>`count(*) filter (where ${schema.ticket.status} = 'waiting')::int`,
            unassigned: sql<number>`count(*) filter (where ${schema.ticket.status} = 'open' and ${schema.ticket.assigneeId} is null)::int`,
            unknownSender: sql<number>`count(*) filter (where ${schema.ticket.unknownSender} and ${schema.ticket.status} <> 'closed')::int`,
        })
        .from(schema.ticket)
        .where(isNull(schema.ticket.mergedIntoTicketId));

    return row ?? { open: 0, waiting: 0, unassigned: 0, unknownSender: 0 };
}

export async function listCannedReplies(db: Executor) {
    return db
        .select()
        .from(schema.ticketCannedReply)
        .orderBy(asc(schema.ticketCannedReply.title));
}
