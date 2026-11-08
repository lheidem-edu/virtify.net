import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { json, notFound } from "@/server/api/respond";
import { serializeTicket } from "@/server/tickets/api";
import { ANY_CUSTOMER, loadTicket } from "@/server/tickets/repository";

export const dynamic = "force-dynamic";

/**
 * One ticket with its conversation.
 *
 * A row this key may not see is 404, never 403 — a ticket number is short
 * and guessable, and 403 would confirm which ones exist.
 */
export async function GET(
    request: Request,
    context: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "tickets.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await context.params;
    const own = scopedCustomerId(auth.context);
    const loaded = await loadTicket(id, own ?? ANY_CUSTOMER, db);

    if (!loaded) {
        return notFound("Dieses Ticket gibt es nicht.");
    }

    return json(serializeTicket(loaded));
}
