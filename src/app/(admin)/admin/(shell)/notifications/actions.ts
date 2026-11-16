"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { type Actor, audit } from "@/server/audit";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import { isResendable, resendMail } from "@/server/mail/outbox";
import { emailById } from "@/server/mail/repository";
import { runMailPass } from "@/server/mail/run";

/**
 * The two buttons on the notification log.
 *
 * Both call the same functions the worker does. „Jetzt senden" is
 * `runMailPass`, which is what the `mail/run` schedule runs, and „erneut
 * senden" is `resendMail`, which claims a resend number on the original row
 * and queues a *new* one. Neither of them sends anything itself: there is one
 * sender and it is the outbox.
 */

export type NotificationActionState = {
    status: "idle" | "ok" | "error";
    message?: string;
};

const resendSchema = z.object({
    id: z.string().min(1),
    /**
     * The resend counter the form was rendered with. It is the precondition
     * of the claim, not information — a double-clicked button sends the same
     * value twice and the second request finds the counter already moved.
     */
    resendCount: z.coerce.number().int().min(0),
});

export async function resendNotification(
    _previous: NotificationActionState,
    data: FormData,
): Promise<NotificationActionState> {
    const session = await requirePermission("notifications.send");

    const parsed = resendSchema.safeParse({
        id: data.get("id"),
        resendCount: data.get("resendCount"),
    });

    if (!parsed.success) {
        return { status: "error", message: "Ungültige Anfrage." };
    }

    const row = await emailById(db, parsed.data.id);

    if (!row) {
        // 404 rather than 403, and the same wording whether the row is
        // somebody else's or does not exist (rule 5).
        return { status: "error", message: "Diese Nachricht gibt es nicht." };
    }

    if (!isResendable(row.template)) {
        return {
            status: "error",
            message:
                "Diese Nachricht kann nicht erneut versendet werden. Bestätigungslinks sind einmalig, und ein Dokument wird über die Rechnung selbst noch einmal verschickt.",
        };
    }

    try {
        const id = await resendMail(db, {
            id: parsed.data.id,
            expectedResendCount: parsed.data.resendCount,
        });

        if (!id) {
            return {
                status: "error",
                message:
                    "Diese Nachricht wurde bereits erneut versendet. Lade die Seite neu, wenn du es noch einmal brauchst.",
            };
        }

        const origin = await requestOrigin();

        await audit(db, {
            actor: {
                type: "staff",
                id: session.user.id,
                label: session.user.email,
            } satisfies Actor,
            action: "notification.resend",
            entityType: "email_log",
            entityId: parsed.data.id,
            after: {
                template: row.template,
                to: row.toEmail,
                queued: id,
                resend: parsed.data.resendCount + 1,
            },
            ip: origin.ip,
            userAgent: origin.userAgent,
        });

        revalidatePath("/admin/notifications");

        return {
            status: "ok",
            message: "Die Nachricht steht erneut in der Warteschlange.",
        };
    } catch (error) {
        return {
            status: "error",
            message:
                error instanceof Error
                    ? error.message
                    : "Der erneute Versand ist fehlgeschlagen.",
        };
    }
}

/**
 * „Jetzt senden" — dispatch the events and drain the outbox, in this request.
 *
 * A plain call rather than a job on the queue, for the same reason „jetzt
 * abrechnen" is: the operator pressing it wants to see what happened, and the
 * pass is safe to repeat because every row is claimed with a conditional
 * update before it is touched.
 */
export async function runNotificationsNow(
    _previous: NotificationActionState,
    _data: FormData,
): Promise<NotificationActionState> {
    await requirePermission("notifications.send");

    try {
        const report = await runMailPass(db);

        revalidatePath("/admin/notifications");

        const parts = [
            `${report.events.dispatched} Ereignis(se) verarbeitet`,
            `${report.outbox.sent} Nachricht(en) versendet`,
        ];

        if (report.outbox.failed > 0) {
            parts.push(`${report.outbox.failed} fehlgeschlagen`);
        }

        if (report.outbox.skipped > 0) {
            parts.push(`${report.outbox.skipped} übersprungen`);
        }

        if (report.outbox.expired > 0) {
            parts.push(`${report.outbox.expired} ungeklärt`);
        }

        return { status: "ok", message: `${parts.join(", ")}.` };
    } catch (error) {
        return {
            status: "error",
            message:
                error instanceof Error
                    ? error.message
                    : "Der Versandlauf ist fehlgeschlagen.",
        };
    }
}
