"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { getCurrentCustomer } from "@/server/customers/current";
import { mailChannel } from "@/server/tickets/channels";
import { sendTicketConfirmation } from "@/server/tickets/outbound";
import { loadTicket } from "@/server/tickets/repository";
import {
    addCustomerMessage,
    createTicket,
    TicketError,
    updateTicket,
} from "@/server/tickets/service";
import { loadMailChannelConfig } from "@/server/tickets/settings";

/**
 * The customer's two buttons: open a ticket, answer one.
 *
 * Hard rule 5 twice over. The account comes from `getCurrentCustomer()` and
 * never from the form, and every ticket is loaded **scoped to that account**
 * before anything is written to it — so a ticket id typed into the request
 * that belongs to somebody else does not resolve at all.
 */

export type ClientTicketState = {
    status: "idle" | "done" | "error";
    message?: string;
};

export async function createTicketAction(
    _state: ClientTicketState,
    form: FormData,
): Promise<ClientTicketState> {
    const { customer, contact, user } = await getCurrentCustomer();

    if (!contact.canTickets) {
        return {
            status: "error",
            message: "Dieser Zugang darf keine Tickets eröffnen.",
        };
    }

    let ticketId: string;

    try {
        const created = await createTicket(
            db,
            {
                customerId: customer.id,
                contactId: contact.id,
                departmentId: String(form.get("departmentId") ?? "") || null,
                subject: String(form.get("subject") ?? ""),
                body: String(form.get("body") ?? ""),
                // Deliberately not from the form: a customer sets what they
                // need, not how urgent we treat it.
                priority: "normal",
                requesterEmail: contact.email,
                requesterName: user.name,
            },
            { type: "customer", id: contact.id, label: contact.email },
        );

        ticketId = created.ticketId;
    } catch (error) {
        if (error instanceof TicketError) {
            return { status: "error", message: error.message };
        }

        throw error;
    }

    /**
     * The acknowledgement the portal promises — "Du bekommst eine
     * Bestätigung an deine Kontaktadresse" — and which only mail-opened
     * tickets used to get. It is not a nicety here: it is the mail the
     * customer replies to, and the tag in its subject is how that reply
     * comes back to this ticket rather than opening a second one.
     *
     * Best effort and deliberately after the ticket exists, the same way
     * the inbound pass does it: a ticket with no acknowledgement is a far
     * better state than an acknowledgement for a ticket that does not.
     */
    try {
        const config = await loadMailChannelConfig();
        const channel = await mailChannel(config.id);

        if (channel) {
            await sendTicketConfirmation(db, channel, {
                ticketId,
                limitPerHour: config.autoReplyPerHour,
            });
        }
    } catch (error) {
        console.error(
            "[tickets] the confirmation for a portal ticket could not be sent:",
            error,
        );
    }

    revalidatePath("/client/tickets");
    revalidatePath("/admin/tickets");
    redirect(`/client/tickets/${ticketId}`);
}

export async function replyAction(
    _state: ClientTicketState,
    form: FormData,
): Promise<ClientTicketState> {
    const { customer, contact } = await getCurrentCustomer();

    if (!contact.canTickets) {
        return {
            status: "error",
            message: "Dieser Zugang darf nicht auf Tickets antworten.",
        };
    }

    const ticketId = String(form.get("ticketId") ?? "");
    const loaded = await loadTicket(ticketId, customer.id, db);

    if (!loaded) {
        return { status: "error", message: "Dieses Ticket gibt es nicht." };
    }

    try {
        await addCustomerMessage(
            db,
            {
                ticketId: loaded.ticket.id,
                body: String(form.get("body") ?? ""),
                authorEmail: contact.email,
                contactId: contact.id,
            },
            { type: "customer", id: contact.id, label: contact.email },
        );
    } catch (error) {
        if (error instanceof TicketError) {
            return { status: "error", message: error.message };
        }

        throw error;
    }

    revalidatePath(`/client/tickets/${ticketId}`);
    revalidatePath("/admin/tickets");

    return { status: "done", message: "Antwort gespeichert." };
}

export async function closeAction(
    _state: ClientTicketState,
    form: FormData,
): Promise<ClientTicketState> {
    const { customer, contact } = await getCurrentCustomer();

    // The page hides the form, but a server action is reachable without the
    // page — the same check the reply makes, for the same reason.
    if (!contact.canTickets) {
        return {
            status: "error",
            message: "Dieser Zugang darf keine Tickets bearbeiten.",
        };
    }

    const ticketId = String(form.get("ticketId") ?? "");
    const loaded = await loadTicket(ticketId, customer.id, db);

    if (!loaded) {
        return { status: "error", message: "Dieses Ticket gibt es nicht." };
    }

    await updateTicket(
        db,
        loaded.ticket.id,
        { status: "closed" },
        {
            type: "customer",
            id: contact.id,
            label: contact.email,
        },
    );

    revalidatePath(`/client/tickets/${ticketId}`);
    revalidatePath("/admin/tickets");

    return { status: "done", message: "Ticket geschlossen." };
}
