import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import {
    invalid,
    json,
    malformed,
    notFound,
    problem,
} from "@/server/api/respond";
import { serializeTicket, ticketMessageSchema } from "@/server/tickets/api";
import { mailChannel } from "@/server/tickets/channels";
import { contactEmailFor } from "@/server/tickets/contacts";
import { replyToTicket } from "@/server/tickets/outbound";
import { ANY_CUSTOMER, loadTicket } from "@/server/tickets/repository";
import {
    addCustomerMessage,
    TicketError,
    updateTicket,
} from "@/server/tickets/service";

export const dynamic = "force-dynamic";

/**
 * Adds a message to a ticket.
 *
 * What that means depends on who is asking, and deliberately so:
 *
 *  - a **customer key** adds the customer's own message. Nothing is mailed;
 *    staff see it in the queue, exactly as the portal's reply box does.
 *  - a **staff key** sends a reply through the ticket's channel, to the
 *    recipients the ticket already knows about (`replyRecipients`) and to
 *    nobody the request names. With no channel configured the reply is
 *    refused rather than recorded as sent, because a reply the customer
 *    never receives is worse than one that was not accepted.
 */
export async function POST(
    request: Request,
    context: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "tickets.reply");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await context.params;
    const own = scopedCustomerId(auth.context);
    const loaded = await loadTicket(id, own ?? ANY_CUSTOMER, db);

    if (!loaded) {
        return notFound("Dieses Ticket gibt es nicht.");
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    const parsed = ticketMessageSchema.safeParse(body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const actor = {
        type: "api" as const,
        id: auth.context.key.id,
        label: auth.context.key.prefix,
    };

    try {
        if (own) {
            await addCustomerMessage(
                db,
                {
                    ticketId: loaded.ticket.id,
                    body: parsed.data.message,
                    authorEmail:
                        (await contactEmailFor(db, own)) ??
                        loaded.ticket.requesterEmail,
                },
                actor,
            );

            if (parsed.data.close) {
                await updateTicket(
                    db,
                    loaded.ticket.id,
                    { status: "closed" },
                    actor,
                );
            }
        } else {
            const channel = await mailChannel();

            if (!channel) {
                return problem(
                    503,
                    "Kein Postfach angebunden",
                    "Es ist kein Mail-Kanal eingerichtet, über den die Antwort hinausgehen könnte.",
                );
            }

            await replyToTicket(
                db,
                channel,
                {
                    ticketId: loaded.ticket.id,
                    body: parsed.data.message,
                    closeTicket: parsed.data.close,
                },
                actor,
            );
        }
    } catch (error) {
        if (error instanceof TicketError) {
            return problem(422, "Nachricht nicht möglich", error.message);
        }

        throw error;
    }

    const refreshed = await loadTicket(
        loaded.ticket.id,
        own ?? ANY_CUSTOMER,
        db,
    );

    return json(refreshed ? serializeTicket(refreshed) : {}, 201);
}
