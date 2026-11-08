"use server";

import { eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { audit } from "@/server/audit";
import { requirePermission } from "@/server/auth/staff-session";
import {
    type GraphCredentials,
    loadMailChannelConfig,
    type MailTransportId,
    mergeGraphCredentials,
    saveMailChannelConfig,
} from "@/server/tickets/settings";

export type MailSettingsState = {
    status: "idle" | "done" | "error";
    message?: string;
};

function text(form: FormData, key: string): string {
    return String(form.get(key) ?? "").trim();
}

/**
 * Saves the Graph channel.
 *
 * The secrets are merged field by field over what is stored — the same fix
 * `src/server/payments/settings.ts` carries. An all-or-nothing save blanks
 * the field the operator deliberately left empty, and for this channel that
 * means an app registration that can no longer sign in at all.
 *
 * Nothing here is ever written to an audit entry's `before`/`after`: a
 * client secret in the log is a client secret in every backup of it.
 */
export async function saveMailChannelAction(
    _state: MailSettingsState,
    form: FormData,
): Promise<MailSettingsState> {
    const session = await requirePermission("tickets.manage");
    const current = await loadMailChannelConfig();

    const submitted: Partial<Record<keyof GraphCredentials, string>> = {
        tenantId: text(form, "tenantId"),
        clientId: text(form, "clientId"),
        clientSecret: text(form, "clientSecret"),
    };

    const credentials =
        form.get("clear") === "on"
            ? null
            : mergeGraphCredentials(submitted, current.credentials);

    const maxAttachmentMb = Number(text(form, "maxAttachmentMb"));
    const autoReplyPerHour = Number(text(form, "autoReplyPerHour"));

    if (!Number.isFinite(maxAttachmentMb) || maxAttachmentMb <= 0) {
        return {
            status: "error",
            message: "Die Anhangsgrenze muss eine Zahl größer als 0 sein.",
        };
    }

    if (!Number.isFinite(autoReplyPerHour) || autoReplyPerHour < 0) {
        return {
            status: "error",
            message: "Die Antwortgrenze muss 0 oder größer sein.",
        };
    }

    const transport: MailTransportId =
        text(form, "transport") === "graph" ? "graph" : "smtp";

    await db.transaction(async (tx) => {
        await saveMailChannelConfig(tx, "msgraph", {
            enabled: form.get("enabled") === "on",
            processedFolder: text(form, "processedFolder") || "Processed",
            maxAttachmentBytes: Math.round(maxAttachmentMb * 1024 * 1024),
            autoReplyPerHour: Math.round(autoReplyPerHour),
            outboundSender: text(form, "outboundSender").toLowerCase() || null,
            transport,
            credentials,
        });

        await audit(tx, {
            actor: {
                type: "staff",
                id: session.user.id,
                label: session.user.email,
            },
            action: "mail_channel.update",
            entityType: "mail_channel",
            entityId: "msgraph",
            after: {
                enabled: form.get("enabled") === "on",
                transport,
                // Whether a secret changed, never the secret.
                credentialsChanged: credentials !== undefined,
            },
        });
    });

    revalidatePath("/admin/settings/mail");

    return { status: "done", message: "Gespeichert." };
}

export async function saveDepartmentAction(
    _state: MailSettingsState,
    form: FormData,
): Promise<MailSettingsState> {
    const session = await requirePermission("tickets.manage");

    const id = text(form, "id");
    const name = text(form, "name");
    const mailbox = text(form, "mailbox").toLowerCase();
    const slug = (text(form, "slug") || name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

    if (name === "" || mailbox === "" || !mailbox.includes("@")) {
        return {
            status: "error",
            message: "Name und ein gültiges Postfach sind Pflicht.",
        };
    }

    try {
        await db.transaction(async (tx) => {
            if (id) {
                await tx
                    .update(schema.ticketDepartment)
                    .set({
                        name,
                        slug,
                        mailbox,
                        description: text(form, "description") || null,
                        isDefault: form.get("isDefault") === "on",
                        active: form.get("active") === "on",
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.ticketDepartment.id, id));
            } else {
                await tx.insert(schema.ticketDepartment).values({
                    name,
                    slug,
                    mailbox,
                    description: text(form, "description") || null,
                    isDefault: form.get("isDefault") === "on",
                    active: form.get("active") !== "off",
                });
            }

            /**
             * Exactly one default, or "where does an unrouted ticket go"
             * has two answers and `defaultDepartment()` picks whichever
             * the index happened to return first.
             */
            if (form.get("isDefault") === "on") {
                await tx
                    .update(schema.ticketDepartment)
                    .set({ isDefault: false, updatedAt: new Date() })
                    .where(ne(schema.ticketDepartment.slug, slug));
            }

            await audit(tx, {
                actor: {
                    type: "staff",
                    id: session.user.id,
                    label: session.user.email,
                },
                action: id
                    ? "ticket_department.update"
                    : "ticket_department.create",
                entityType: "ticket_department",
                entityId: id || slug,
                after: { name, mailbox, slug },
            });
        });
    } catch (error) {
        const detail = error as { code?: string };

        if (detail?.code === "23505") {
            return {
                status: "error",
                message:
                    "Dieses Postfach oder dieses Kürzel gibt es schon. Ein Postfach gehört zu genau einer Abteilung.",
            };
        }

        throw error;
    }

    revalidatePath("/admin/settings/mail");
    revalidatePath("/admin/tickets");

    return { status: "done", message: "Abteilung gespeichert." };
}
