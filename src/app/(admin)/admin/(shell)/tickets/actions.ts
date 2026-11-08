"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/db";
import type { TicketPriority, TicketStatus } from "@/db/schema";
import { requirePermission } from "@/server/auth/staff-session";
import { mailChannel } from "@/server/tickets/channels";
import { reopenInboundMail } from "@/server/tickets/inbound";
import { replyToTicket } from "@/server/tickets/outbound";
import { runSubscriptionSync, runTicketSweep } from "@/server/tickets/run";
import {
    addInternalNote,
    mergeTickets,
    TicketError,
    unmergeTicket,
    updateTicket,
} from "@/server/tickets/service";

/**
 * The operator's buttons. Thin by design: the threading, the loop
 * protection, what a merge does and what it gives back all live in
 * `src/server/tickets`, which the tests drive directly.
 */

export type TicketActionState = {
    status: "idle" | "done" | "error";
    message?: string;
};

async function staffActor(
    permission: "tickets.reply" | "tickets.write" | "tickets.manage",
) {
    const session = await requirePermission(permission);

    await headers();

    return {
        type: "staff" as const,
        id: session.user.id,
        label: session.user.email,
    };
}

function refresh(ticketId?: string) {
    revalidatePath("/admin/tickets");

    if (ticketId) {
        revalidatePath(`/admin/tickets/${ticketId}`);
    }

    revalidatePath("/client/tickets");
}

async function attempt(
    ticketId: string | undefined,
    run: () => Promise<string>,
): Promise<TicketActionState> {
    try {
        const message = await run();

        refresh(ticketId);

        return { status: "done", message };
    } catch (error) {
        if (error instanceof TicketError) {
            return { status: "error", message: error.message };
        }

        console.error("[tickets] an action failed:", error);

        /**
         * Only a `TicketError` is written for a person to read. Everything
         * else is a `GraphError` or a database error, whose message is
         * English and carries a URL, a status and 300 bytes of somebody
         * else's response body — none of which belongs on a German screen,
         * and some of which is nobody's business but the log's.
         */
        return {
            status: "error",
            message:
                "Das hat nicht funktioniert. Die Einzelheiten stehen im Log.",
        };
    }
}

export async function replyAction(
    _state: TicketActionState,
    form: FormData,
): Promise<TicketActionState> {
    const actor = await staffActor("tickets.reply");
    const ticketId = String(form.get("ticketId") ?? "");

    return attempt(ticketId, async () => {
        const channel = await mailChannel();

        if (!channel) {
            throw new TicketError(
                "Es ist kein Postfach angebunden. Unter Einstellungen → Postfach einrichten.",
            );
        }

        const result = await replyToTicket(
            db,
            channel,
            {
                ticketId,
                body: String(form.get("body") ?? ""),
                cc: String(form.get("cc") ?? "")
                    .split(/[,;\s]+/)
                    .filter(Boolean),
                closeTicket: form.get("close") === "on",
                authorName: actor.label,
            },
            actor,
        );

        if (!result.recorded) {
            // The customer has the answer. Saying "gesendet" here and
            // showing nothing in the conversation is how it gets sent twice.
            return (
                `Antwort an ${result.recipients.join(", ")} gesendet, ` +
                "konnte aber nicht im Ticket gespeichert werden. " +
                "Bitte nicht erneut senden — die Nachricht ist beim Kunden."
            );
        }

        return `Antwort an ${result.recipients.join(", ")} gesendet.`;
    });
}

export async function noteAction(
    _state: TicketActionState,
    form: FormData,
): Promise<TicketActionState> {
    const actor = await staffActor("tickets.reply");
    const ticketId = String(form.get("ticketId") ?? "");

    return attempt(ticketId, async () => {
        await addInternalNote(
            db,
            { ticketId, body: String(form.get("body") ?? "") },
            actor,
        );

        return "Notiz gespeichert.";
    });
}

export async function updateAction(
    _state: TicketActionState,
    form: FormData,
): Promise<TicketActionState> {
    const actor = await staffActor("tickets.write");
    const ticketId = String(form.get("ticketId") ?? "");

    return attempt(ticketId, async () => {
        const assignee = String(form.get("assigneeId") ?? "");
        const customerId = String(form.get("customerId") ?? "");

        await updateTicket(
            db,
            ticketId,
            {
                status: (form.get("status") as TicketStatus) || undefined,
                priority: (form.get("priority") as TicketPriority) || undefined,
                assigneeId: assignee === "" ? null : assignee,
                ...(form.has("customerId")
                    ? { customerId: customerId === "" ? null : customerId }
                    : {}),
            },
            actor,
        );

        return "Gespeichert.";
    });
}

export async function mergeAction(
    _state: TicketActionState,
    form: FormData,
): Promise<TicketActionState> {
    const actor = await staffActor("tickets.write");
    const sourceId = String(form.get("ticketId") ?? "");
    const targetId = String(form.get("targetId") ?? "");

    return attempt(sourceId, async () => {
        await mergeTickets(db, { sourceId, targetId }, actor);

        return "Zusammengeführt.";
    });
}

export async function unmergeAction(
    _state: TicketActionState,
    form: FormData,
): Promise<TicketActionState> {
    const actor = await staffActor("tickets.write");
    const ticketId = String(form.get("ticketId") ?? "");

    return attempt(ticketId, async () => {
        await unmergeTicket(db, ticketId, actor);

        return "Wieder getrennt.";
    });
}

/**
 * "Jetzt abholen". The same function the worker's cron calls, run in the
 * request so the operator sees what happened — the arrangement "jetzt
 * abrechnen" already has, and for the same reason.
 */
export async function sweepAction(
    _state: TicketActionState,
    _form: FormData,
): Promise<TicketActionState> {
    await staffActor("tickets.manage");

    return attempt(undefined, async () => {
        const result = await runTicketSweep(db);

        if (!result.ran) {
            throw new TicketError(
                "Es ist kein Postfach angebunden. Unter Einstellungen → Postfach einrichten.",
            );
        }

        const counts = Object.entries(result.report?.results ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ");

        return counts === ""
            ? "Nichts Neues im Postfach."
            : `Abgeholt — ${counts}.`;
    });
}

export async function syncSubscriptionsAction(
    _state: TicketActionState,
    _form: FormData,
): Promise<TicketActionState> {
    await staffActor("tickets.manage");

    return attempt(undefined, async () => {
        const result = await runSubscriptionSync(db);

        if (!result.ran) {
            throw new TicketError(
                result.reason === "notification-url-not-https"
                    ? "Graph nimmt nur eine https-Adresse an. BETTER_AUTH_URL zeigt auf keine."
                    : "Es ist kein Postfach angebunden.",
            );
        }

        const report = result.report;

        return `Angelegt: ${report?.created.length ?? 0}, erneuert: ${
            report?.renewed.length ?? 0
        }, entfernt: ${report?.removed.length ?? 0}, Fehler: ${
            report?.failed.length ?? 0
        }.`;
    });
}

/** The way back: a message marked processed goes round again. */
export async function reprocessAction(
    _state: TicketActionState,
    form: FormData,
): Promise<TicketActionState> {
    await staffActor("tickets.manage");

    return attempt(undefined, async () => {
        const ok = await reopenInboundMail(
            db,
            String(form.get("inboundMailId") ?? ""),
        );

        if (!ok) {
            throw new TicketError("Diese Nachricht gibt es nicht.");
        }

        return "Die Nachricht wird beim nächsten Abholen erneut verarbeitet.";
    });
}
