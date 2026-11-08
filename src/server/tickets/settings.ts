import "server-only";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * The mail channel's configuration, and where it comes from.
 *
 * Shaped after `src/server/payments/settings.ts`, for the same reasons: the
 * secrets are one encrypted blob (hard rule 6), the rest are columns the
 * admin area reads back, and the environment fills in for a developer who
 * has a `.env.local` and no interest in the admin form.
 *
 * **There are no credentials for this installation yet, and none are to be
 * gone looking for.** Everything below works against the documented Graph
 * contract; with no credentials the channel reports itself unconfigured and
 * every job that would have talked to Microsoft does nothing instead.
 */

export type MailChannelId = "msgraph";

export const MAIL_CHANNEL_IDS: MailChannelId[] = ["msgraph"];

export const MAIL_CHANNEL_LABEL: Record<MailChannelId, string> = {
    msgraph: "Microsoft 365 (Graph)",
};

/** Which way the system's own mail (invoices, Mahnungen) goes out. */
export type MailTransportId = "smtp" | "graph";

export type GraphCredentials = {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    /** PEM private key for certificate auth. Preferred; not yet implemented. */
    certificatePrivateKey?: string;
    certificateThumbprint?: string;
};

export type MailChannelConfig = {
    id: MailChannelId;
    label: string;
    enabled: boolean;
    credentials: GraphCredentials;
    source: "database" | "environment";
    processedFolder: string;
    maxAttachmentBytes: number;
    autoReplyPerHour: number;
    outboundSender: string | null;
    transport: MailTransportId;
};

const CONTEXT = (id: MailChannelId) => `mail_channel.${id}.credentials`;

export const EMPTY_GRAPH_CREDENTIALS: GraphCredentials = {
    tenantId: "",
    clientId: "",
    clientSecret: "",
};

export const DEFAULT_MAIL_CHANNEL: Omit<MailChannelConfig, "id" | "label"> = {
    enabled: false,
    credentials: EMPTY_GRAPH_CREDENTIALS,
    source: "environment",
    processedFolder: "Processed",
    maxAttachmentBytes: 20 * 1024 * 1024,
    autoReplyPerHour: 4,
    outboundSender: null,
    transport: "smtp",
};

/**
 * A client secret alone is enough to *talk* to Graph; what the channel needs
 * is all three, because a half-filled form is how an operator discovers the
 * integration is off from a customer rather than from this page.
 */
export function hasWhatItNeeds(credentials: GraphCredentials): boolean {
    return (
        credentials.tenantId.trim() !== "" &&
        credentials.clientId.trim() !== "" &&
        (credentials.clientSecret.trim() !== "" ||
            (credentials.certificatePrivateKey ?? "").trim() !== "")
    );
}

function fromEnvironment(): {
    credentials: GraphCredentials;
    present: boolean;
} {
    // Trimmed, because a trailing newline in a `.env.local` is the single
    // most common way a secret "does not work".
    const credentials: GraphCredentials = {
        tenantId: env.MSGRAPH_TENANT_ID.trim(),
        clientId: env.MSGRAPH_CLIENT_ID.trim(),
        clientSecret: env.MSGRAPH_CLIENT_SECRET.trim(),
    };

    return { credentials, present: hasWhatItNeeds(credentials) };
}

export const loadMailChannelConfig = cache(
    async (id: MailChannelId = "msgraph"): Promise<MailChannelConfig> => {
        let row: typeof schema.mailChannelSetting.$inferSelect | undefined;

        try {
            [row] = await db
                .select()
                .from(schema.mailChannelSetting)
                .where(eq(schema.mailChannelSetting.id, id))
                .limit(1);
        } catch (error) {
            // A page must still render when the database is briefly away.
            console.error(
                "[tickets] falling back to the environment for the mail channel:",
                error,
            );
        }

        const environment = fromEnvironment();
        let credentials = environment.credentials;
        let source: MailChannelConfig["source"] = "environment";

        if (row?.credentials) {
            try {
                credentials = JSON.parse(
                    decrypt(row.credentials, CONTEXT(id)),
                ) as GraphCredentials;
                source = "database";
            } catch (error) {
                // A blob that will not open is a configuration fault, not a
                // reason to quietly fall back to a *different* tenant's keys.
                console.error(
                    `[tickets] the stored ${id} credentials could not be decrypted:`,
                    error,
                );
                credentials = EMPTY_GRAPH_CREDENTIALS;
                source = "database";
            }
        }

        const usable = hasWhatItNeeds(credentials);

        return {
            id,
            label: MAIL_CHANNEL_LABEL[id],
            enabled: usable && (row ? row.enabled : environment.present),
            credentials,
            source,
            processedFolder:
                row?.processedFolder ?? DEFAULT_MAIL_CHANNEL.processedFolder,
            maxAttachmentBytes:
                row?.maxAttachmentBytes ??
                DEFAULT_MAIL_CHANNEL.maxAttachmentBytes,
            autoReplyPerHour:
                row?.autoReplyPerHour ?? DEFAULT_MAIL_CHANNEL.autoReplyPerHour,
            outboundSender: row?.outboundSender ?? null,
            transport:
                row?.transport === "graph"
                    ? "graph"
                    : DEFAULT_MAIL_CHANNEL.transport,
        };
    },
);

export type MailChannelUpdate = {
    enabled: boolean;
    processedFolder: string;
    maxAttachmentBytes: number;
    autoReplyPerHour: number;
    outboundSender: string | null;
    transport: MailTransportId;
    /**
     * Omitted leaves what is stored alone, so the operator can flip the
     * switch without re-typing a secret they cannot read back. An explicit
     * `null` clears the row and returns the channel to the environment.
     */
    credentials?: GraphCredentials | null;
};

export async function saveMailChannelConfig(
    executor: Pick<typeof db, "insert">,
    id: MailChannelId,
    update: MailChannelUpdate,
): Promise<void> {
    const blob =
        update.credentials === undefined
            ? undefined
            : update.credentials === null
              ? null
              : encrypt(JSON.stringify(update.credentials), CONTEXT(id));

    const columns = {
        enabled: update.enabled,
        processedFolder: update.processedFolder,
        maxAttachmentBytes: update.maxAttachmentBytes,
        autoReplyPerHour: update.autoReplyPerHour,
        outboundSender: update.outboundSender,
        transport: update.transport,
        updatedAt: new Date(),
    };

    await executor
        .insert(schema.mailChannelSetting)
        .values({ id, credentials: blob ?? null, ...columns })
        .onConflictDoUpdate({
            target: schema.mailChannelSetting.id,
            set: {
                ...columns,
                ...(blob === undefined ? {} : { credentials: blob }),
            },
        });
}

/**
 * Merges submitted secrets over the stored ones, field by field — the same
 * fix `src/server/payments/settings.ts` carries, and for the same reason: an
 * all-or-nothing save blanks the field the operator left empty on purpose.
 * Returns `undefined` when nothing actually changed.
 */
export function mergeGraphCredentials(
    submitted: Partial<Record<keyof GraphCredentials, string>>,
    stored: GraphCredentials,
): GraphCredentials | undefined {
    const fields: (keyof GraphCredentials)[] = [
        "tenantId",
        "clientId",
        "clientSecret",
        "certificatePrivateKey",
        "certificateThumbprint",
    ];

    const next: GraphCredentials = { ...stored };
    let changed = false;

    for (const field of fields) {
        const value = (submitted[field] ?? "").trim();

        if (value && value !== stored[field]) {
            next[field] = value;
            changed = true;
        }
    }

    return changed ? next : undefined;
}
