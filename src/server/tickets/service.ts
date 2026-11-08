import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { Ticket, TicketPriority, TicketStatus } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { defaultDepartment, departmentById } from "./departments";
import { nextTicketNumber } from "./numbering";
import { prepareBody } from "./quoting";
import { matchContact } from "./threading";

/**
 * Everything that changes a ticket, in one place and taking an executor.
 *
 * The pages, the server actions and `/api/v1` all call these; none of them
 * writes a ticket row itself. The rule is the one the rest of this codebase
 * follows — the admin's "Zuweisen" button and a staff API key's PATCH have
 * to mean exactly the same thing, including the audit entry they leave.
 */

type Db = typeof defaultDb;

export class TicketError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TicketError";
    }
}

export type CreateTicketInput = {
    customerId: string | null;
    contactId?: string | null;
    departmentId?: string | null;
    subject: string;
    body: string;
    priority?: TicketPriority;
    requesterEmail: string;
    requesterName?: string | null;
    serviceId?: string | null;
    invoiceId?: string | null;
};

export type CreatedTicket = {
    ticketId: string;
    number: number;
    messageId: string;
};

/**
 * A ticket opened from the portal or through the API.
 *
 * The first message is recorded as `inbound` even though it never touched a
 * mailbox: the conversation view shows who said what, and "the customer
 * said this" is what this is, whatever carried it. It gets no
 * `internet_message_id`, because there is no message out there with one —
 * and the unique index tolerates any number of nulls, which is exactly the
 * behaviour wanted.
 */
export async function createTicket(
    db: Db,
    input: CreateTicketInput,
    actor: Actor,
): Promise<CreatedTicket> {
    const subject = input.subject.trim();
    const body = input.body.trim();

    if (subject === "") {
        throw new TicketError("Ein Ticket braucht einen Betreff.");
    }

    if (body === "") {
        throw new TicketError("Ein Ticket braucht eine Nachricht.");
    }

    const department = input.departmentId
        ? await departmentById(db, input.departmentId)
        : await defaultDepartment(db);

    if (!department?.active) {
        throw new TicketError(
            "Es ist keine Abteilung eingerichtet, an die das Ticket gehen könnte.",
        );
    }

    const contact =
        input.contactId !== undefined && input.contactId !== null
            ? { customerId: input.customerId ?? "", contactId: input.contactId }
            : await matchContact(db, input.requesterEmail);

    const messageId = createId("ticketmessage");

    return db.transaction(async (tx) => {
        const number = await nextTicketNumber(tx);

        const [ticket] = await tx
            .insert(schema.ticket)
            .values({
                number,
                departmentId: department.id,
                customerId: input.customerId ?? contact?.customerId ?? null,
                contactId: input.contactId ?? contact?.contactId ?? null,
                unknownSender:
                    (input.customerId ?? contact?.customerId ?? null) === null,
                subject,
                status: "open",
                priority: input.priority ?? "normal",
                requesterEmail: input.requesterEmail.trim().toLowerCase(),
                requesterName: input.requesterName ?? null,
                serviceId: input.serviceId ?? null,
                invoiceId: input.invoiceId ?? null,
                lastMessageAt: new Date(),
            })
            .returning();

        await tx.insert(schema.ticketMessage).values({
            id: messageId,
            ticketId: ticket.id,
            direction: "inbound",
            authorType: actor.type === "staff" ? "staff" : "customer",
            authorId: actor.id ?? null,
            authorName: input.requesterName ?? null,
            authorEmail: input.requesterEmail.trim().toLowerCase(),
            subject,
            displayText: body,
            originalText: body,
            sentAt: new Date(),
        });

        await audit(tx, {
            actor,
            action: "ticket.create",
            entityType: "ticket",
            entityId: ticket.id,
            after: {
                number: ticket.number,
                subject,
                department: department.name,
                source: "portal",
            },
        });

        return { ticketId: ticket.id, number: ticket.number, messageId };
    });
}

/**
 * A message added to an existing ticket by a person using the portal or the
 * API — not by the mail channel, which goes through
 * `processInboundMessage`.
 */
export async function addCustomerMessage(
    db: Db,
    input: {
        ticketId: string;
        body: string;
        authorEmail: string;
        authorName?: string | null;
        contactId?: string | null;
    },
    actor: Actor,
): Promise<string> {
    const body = input.body.trim();

    if (body === "") {
        throw new TicketError("Eine Antwort darf nicht leer sein.");
    }

    return db.transaction(async (tx) => {
        const [ticket] = await tx
            .select()
            .from(schema.ticket)
            .where(eq(schema.ticket.id, input.ticketId))
            .for("update")
            .limit(1);

        if (!ticket) {
            throw new TicketError("Das Ticket gibt es nicht.");
        }

        if (ticket.mergedIntoTicketId) {
            throw new TicketError(
                "Dieses Ticket wurde zusammengeführt; die Antwort gehört an das Ziel-Ticket.",
            );
        }

        const [message] = await tx
            .insert(schema.ticketMessage)
            .values({
                ticketId: ticket.id,
                direction: "inbound",
                authorType: "customer",
                authorId: input.contactId ?? null,
                authorName: input.authorName ?? null,
                authorEmail: input.authorEmail.trim().toLowerCase(),
                subject: ticket.subject,
                displayText: body,
                originalText: body,
                sentAt: new Date(),
            })
            .returning({ id: schema.ticketMessage.id });

        await tx
            .update(schema.ticket)
            .set({
                status: ticket.status === "on_hold" ? ticket.status : "open",
                closedAt: null,
                lastMessageAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(schema.ticket.id, ticket.id));

        await audit(tx, {
            actor,
            action: "ticket.message",
            entityType: "ticket",
            entityId: ticket.id,
            after: { source: "portal", direction: "inbound" },
        });

        return message.id;
    });
}

/** A staff-only note. It is never sent anywhere, which is the whole point. */
export async function addInternalNote(
    db: Db,
    input: { ticketId: string; body: string; authorName?: string | null },
    actor: Actor,
): Promise<string> {
    const body = input.body.trim();

    if (body === "") {
        throw new TicketError("Eine Notiz darf nicht leer sein.");
    }

    const prepared = prepareBody({ html: null, text: body });

    return db.transaction(async (tx) => {
        const [message] = await tx
            .insert(schema.ticketMessage)
            .values({
                ticketId: input.ticketId,
                direction: "note",
                authorType: "staff",
                authorId: actor.id ?? null,
                authorName: input.authorName ?? actor.label ?? null,
                displayText: prepared.displayText,
                originalText: body,
                sentAt: new Date(),
            })
            .returning({ id: schema.ticketMessage.id });

        await audit(tx, {
            actor,
            action: "ticket.note",
            entityType: "ticket",
            entityId: input.ticketId,
            after: { length: body.length },
        });

        return message.id;
    });
}

export type TicketUpdate = {
    status?: TicketStatus;
    priority?: TicketPriority;
    assigneeId?: string | null;
    departmentId?: string;
    customerId?: string | null;
    serviceId?: string | null;
    invoiceId?: string | null;
};

export async function updateTicket(
    db: Db,
    ticketId: string,
    update: TicketUpdate,
    actor: Actor,
): Promise<Ticket> {
    return db.transaction(async (tx) => {
        const [ticket] = await tx
            .select()
            .from(schema.ticket)
            .where(eq(schema.ticket.id, ticketId))
            .for("update")
            .limit(1);

        if (!ticket) {
            throw new TicketError("Das Ticket gibt es nicht.");
        }

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const values: Record<string, unknown> = { updatedAt: new Date() };

        for (const key of [
            "status",
            "priority",
            "assigneeId",
            "departmentId",
            "customerId",
            "serviceId",
            "invoiceId",
        ] as const) {
            if (!(key in update)) {
                continue;
            }

            const next = update[key] ?? null;

            if (ticket[key] === next) {
                continue;
            }

            before[key] = ticket[key];
            after[key] = next;
            values[key] = next;
        }

        if (Object.keys(after).length === 0) {
            return ticket;
        }

        if ("status" in after) {
            values.closedAt = after.status === "closed" ? new Date() : null;
        }

        if ("customerId" in after) {
            // Linking an account is what clears the flag; it is the one
            // thing the flag was raised for.
            values.unknownSender = after.customerId === null;
        }

        const [updated] = await tx
            .update(schema.ticket)
            .set(values)
            .where(eq(schema.ticket.id, ticketId))
            .returning();

        await audit(tx, {
            actor,
            action: "ticket.update",
            entityType: "ticket",
            entityId: ticketId,
            before,
            after,
        });

        return updated;
    });
}

/**
 * Merges `sourceId` into `targetId`.
 *
 * Every message moves and **each one remembers where it came from**, which
 * is what makes `unmergeTicket` exact rather than approximate. The source
 * ticket keeps its row and its number: the number is a threading key that
 * has been out in the world on a subject line, and a reply carrying it has
 * to keep resolving — to the target, through `mergedIntoTicketId`.
 */
export async function mergeTickets(
    db: Db,
    input: { sourceId: string; targetId: string },
    actor: Actor,
): Promise<void> {
    if (input.sourceId === input.targetId) {
        throw new TicketError(
            "Ein Ticket kann nicht mit sich selbst zusammengeführt werden.",
        );
    }

    await db.transaction(async (tx) => {
        /**
         * Both rows, locked in id order. `ORDER BY` in front of
         * `FOR UPDATE` is what fixes the order Postgres takes them in, so
         * two merges touching the same pair from opposite directions queue
         * rather than deadlock.
         */
        const locked = await tx
            .select()
            .from(schema.ticket)
            .where(inArray(schema.ticket.id, [input.sourceId, input.targetId]))
            .orderBy(asc(schema.ticket.id))
            .for("update");

        const source = locked.find((row) => row.id === input.sourceId);
        const target = locked.find((row) => row.id === input.targetId);

        if (!source || !target) {
            throw new TicketError("Eines der beiden Tickets gibt es nicht.");
        }

        if (source.mergedIntoTicketId) {
            throw new TicketError(
                "Das Quell-Ticket wurde bereits zusammengeführt.",
            );
        }

        if (target.mergedIntoTicketId) {
            // Otherwise the chain grows and `resolveThread` walks it. It may
            // walk ten links; it should never have to.
            throw new TicketError(
                "Das Ziel-Ticket wurde selbst zusammengeführt. Führe auf das Ziel zusammen.",
            );
        }

        await tx
            .update(schema.ticketMessage)
            .set({
                ticketId: target.id,
                mergedFromTicketId: source.id,
                updatedAt: new Date(),
            })
            .where(eq(schema.ticketMessage.ticketId, source.id));

        await tx
            .update(schema.ticket)
            .set({
                mergedIntoTicketId: target.id,
                mergedAt: new Date(),
                status: "closed",
                closedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(schema.ticket.id, source.id));

        await tx
            .update(schema.ticket)
            .set({
                lastMessageAt: new Date(),
                status: target.status === "closed" ? "open" : target.status,
                closedAt: target.status === "closed" ? null : target.closedAt,
                updatedAt: new Date(),
            })
            .where(eq(schema.ticket.id, target.id));

        await audit(tx, {
            actor,
            action: "ticket.merge",
            entityType: "ticket",
            entityId: source.id,
            after: { mergedInto: target.id, targetNumber: target.number },
        });
    });
}

/**
 * The way back. Every message that carries `merged_from_ticket_id = source`
 * goes home and the marker is cleared — so a ticket merged and unmerged is
 * the ticket it was, and messages that arrived at the *target* in the
 * meantime stay where they belong.
 */
export async function unmergeTicket(
    db: Db,
    sourceId: string,
    actor: Actor,
): Promise<void> {
    await db.transaction(async (tx) => {
        const [source] = await tx
            .select()
            .from(schema.ticket)
            .where(eq(schema.ticket.id, sourceId))
            .for("update")
            .limit(1);

        if (!source) {
            throw new TicketError("Das Ticket gibt es nicht.");
        }

        if (!source.mergedIntoTicketId) {
            throw new TicketError("Dieses Ticket wurde nicht zusammengeführt.");
        }

        const moved = await tx
            .update(schema.ticketMessage)
            .set({
                ticketId: sourceId,
                mergedFromTicketId: null,
                updatedAt: new Date(),
            })
            .where(eq(schema.ticketMessage.mergedFromTicketId, sourceId))
            .returning({ id: schema.ticketMessage.id });

        await tx
            .update(schema.ticket)
            .set({
                mergedIntoTicketId: null,
                mergedAt: null,
                status: "open",
                closedAt: null,
                updatedAt: new Date(),
            })
            .where(eq(schema.ticket.id, sourceId));

        await audit(tx, {
            actor,
            action: "ticket.unmerge",
            entityType: "ticket",
            entityId: sourceId,
            before: { mergedInto: source.mergedIntoTicketId },
            after: { messagesReturned: moved.length },
        });
    });
}

/** Tickets a customer may be shown in a picker, newest first. */
export async function openTicketsForCustomer(db: Db, customerId: string) {
    return db
        .select({
            id: schema.ticket.id,
            number: schema.ticket.number,
            subject: schema.ticket.subject,
        })
        .from(schema.ticket)
        .where(
            and(
                eq(schema.ticket.customerId, customerId),
                isNull(schema.ticket.mergedIntoTicketId),
            ),
        )
        .orderBy(sql`${schema.ticket.id} desc`)
        .limit(50);
}
