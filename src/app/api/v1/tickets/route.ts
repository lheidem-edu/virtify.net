import { db } from "@/db";
import type { TicketPriority, TicketStatus } from "@/db/schema";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { invalid, json, malformed, problem } from "@/server/api/respond";
import {
    serializeTicket,
    serializeTicketRow,
    ticketCreateSchema,
} from "@/server/tickets/api";
import { contactEmailFor } from "@/server/tickets/contacts";
import {
    ANY_CUSTOMER,
    listTickets,
    loadTicket,
} from "@/server/tickets/repository";
import { createTicket, TicketError } from "@/server/tickets/service";

export const dynamic = "force-dynamic";

const STATUSES: TicketStatus[] = ["open", "waiting", "on_hold", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

/**
 * The tickets, seitenweise. A customer key sees its own and `customer_id`
 * is overwritten for it rather than honoured — the rule every list in this
 * API follows.
 *
 * A ticket with no customer is reachable only by a staff key, and that is
 * not a check here: `customer_id = $1` cannot match a null, so an unmatched
 * sender's ticket is invisible to every customer by construction.
 */
export async function GET(request: Request) {
    const auth = await authenticate(request, "tickets.read");

    if (!auth.ok) {
        return auth.response;
    }

    const url = new URL(request.url);
    const own = scopedCustomerId(auth.context);
    const limit = Number(url.searchParams.get("limit") ?? "");
    const statusParam = url.searchParams.get("status");

    const page = await listTickets(
        own ?? ANY_CUSTOMER,
        {
            status:
                statusParam === "open-ish"
                    ? "open-ish"
                    : STATUSES.find((entry) => entry === statusParam),
            priority: PRIORITIES.find(
                (entry) => entry === url.searchParams.get("priority"),
            ),
            customerId: url.searchParams.get("customer_id") ?? undefined,
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        },
        db,
    );

    return json({
        data: page.rows.map(serializeTicketRow),
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
    });
}

/**
 * Opens a ticket.
 *
 * `requester_email` is ignored for a customer key — the address comes from
 * the account's own contacts. A key that could name the requester could
 * open a ticket in somebody else's name, and the reply would then go to the
 * address this ticket already knows about rather than the one that asked,
 * which turns a lie into a disclosure.
 */
export async function POST(request: Request) {
    const auth = await authenticate(request, "tickets.write");

    if (!auth.ok) {
        return auth.response;
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    const parsed = ticketCreateSchema.safeParse(body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const own = scopedCustomerId(auth.context);
    const customerId = own ?? parsed.data.customer_id ?? null;

    if (!own && !customerId && !parsed.data.requester_email) {
        return problem(
            422,
            "Eingabe ungültig",
            "Ein Mitarbeiterschlüssel muss `customer_id` oder `requester_email` angeben.",
        );
    }

    const requesterEmail = own
        ? await contactEmailFor(db, own)
        : (parsed.data.requester_email ??
          (customerId ? await contactEmailFor(db, customerId) : null));

    if (!requesterEmail) {
        return problem(
            422,
            "Keine Absenderadresse",
            "Zu diesem Konto ist keine Kontaktadresse hinterlegt.",
        );
    }

    try {
        const created = await createTicket(
            db,
            {
                customerId,
                departmentId: parsed.data.department_id ?? null,
                subject: parsed.data.subject,
                body: parsed.data.message,
                priority: parsed.data.priority,
                requesterEmail,
                requesterName: parsed.data.requester_name ?? null,
                serviceId: own ? null : (parsed.data.service_id ?? null),
                invoiceId: own ? null : (parsed.data.invoice_id ?? null),
            },
            {
                type: "api",
                id: auth.context.key.id,
                label: auth.context.key.prefix,
            },
        );

        const loaded = await loadTicket(
            created.ticketId,
            own ?? ANY_CUSTOMER,
            db,
        );

        if (!loaded) {
            return problem(
                500,
                "Ticket nicht lesbar",
                "Das Ticket wurde angelegt, konnte aber nicht gelesen werden.",
            );
        }

        return json(serializeTicket(loaded), 201);
    } catch (error) {
        if (error instanceof TicketError) {
            return problem(422, "Ticket nicht möglich", error.message);
        }

        throw error;
    }
}
