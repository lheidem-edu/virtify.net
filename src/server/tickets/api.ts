import { z } from "zod";
import type { Ticket, TicketAttachment, TicketMessage } from "@/db/schema";
import { formatTicketNumber } from "./numbering";
import type { LoadedTicket, TicketListRow } from "./repository";

/**
 * The wire shapes for `/api/v1/tickets`, and the one rule they follow:
 * **an internal note is never serialized**. The repository already filters
 * them out of a customer's load, and this does not re-add them — the API
 * has no `include_notes`, for staff keys either, because a note is a thing
 * written in the knowledge that it stays inside.
 */

export const ticketCreateSchema = z.object({
    customer_id: z.string().nullish(),
    department_id: z.string().nullish(),
    subject: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(20_000),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    requester_email: z.email().nullish(),
    requester_name: z.string().trim().max(120).nullish(),
    service_id: z.string().nullish(),
    invoice_id: z.string().nullish(),
});

export const ticketMessageSchema = z.object({
    message: z.string().trim().min(1).max(20_000),
    close: z.boolean().default(false),
});

export type TicketCreateBody = z.infer<typeof ticketCreateSchema>;

export function serializeTicketRow(row: TicketListRow) {
    return {
        id: row.id,
        number: row.number,
        reference: formatTicketNumber(row.number),
        subject: row.subject,
        status: row.status,
        priority: row.priority,
        department: row.departmentName,
        customer_id: row.customerId,
        customer_name: row.customerName,
        assignee: row.assigneeName,
        unknown_sender: row.unknownSender,
        requester_email: row.requesterEmail,
        message_count: row.messageCount,
        last_message_at: row.lastMessageAt.toISOString(),
        created_at: row.createdAt.toISOString(),
        merged_into: row.mergedIntoTicketId,
    };
}

function serializeAttachment(row: TicketAttachment) {
    return {
        id: row.id,
        filename: row.filename,
        content_type: row.contentType,
        size_bytes: row.sizeBytes,
        inline: row.isInline,
    };
}

function serializeMessage(
    message: TicketMessage & { attachments: TicketAttachment[] },
) {
    return {
        id: message.id,
        direction: message.direction,
        author_type: message.authorType,
        author_name: message.authorName,
        author_email: message.authorEmail,
        /**
         * The stripped body — the new part of the message. The original is
         * kept in the database and shown in the admin area; it is not on the
         * wire, because an API consumer asking "what did they say" wants the
         * answer and not the thread it was quoted from.
         */
        body: message.displayText,
        automated: message.isAutomated,
        sent_at: message.sentAt.toISOString(),
        attachments: message.attachments.map(serializeAttachment),
    };
}

export function serializeTicket(loaded: LoadedTicket) {
    const ticket: Ticket = loaded.ticket;

    return {
        id: ticket.id,
        number: ticket.number,
        reference: formatTicketNumber(ticket.number),
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        department: loaded.departmentName,
        customer_id: ticket.customerId,
        customer_name: loaded.customerName,
        assignee: loaded.assigneeName,
        unknown_sender: ticket.unknownSender,
        requester_email: ticket.requesterEmail,
        requester_name: ticket.requesterName,
        service_id: ticket.serviceId,
        invoice_id: ticket.invoiceId,
        merged_into: ticket.mergedIntoTicketId,
        merged_in: loaded.mergedIn.map((row) => ({
            id: row.id,
            number: row.number,
            reference: formatTicketNumber(row.number),
        })),
        first_response_at: ticket.firstResponseAt?.toISOString() ?? null,
        last_message_at: ticket.lastMessageAt.toISOString(),
        closed_at: ticket.closedAt?.toISOString() ?? null,
        created_at: ticket.createdAt.toISOString(),
        messages: loaded.messages
            .filter((message) => message.direction !== "note")
            .map(serializeMessage),
    };
}
