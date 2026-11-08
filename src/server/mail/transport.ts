import "server-only";
import nodemailer from "nodemailer";
import { mailChannel } from "@/server/tickets/channels";
import { loadMailChannelConfig } from "@/server/tickets/settings";

/**
 * How a system mail leaves the building.
 *
 * Phase 7's second job. Until now every notice — the invoice, the Mahnung,
 * the SCA link — went through nodemailer to an SMTP relay, and this
 * installation has never had one, so those mails reached the log and nobody
 * else. `MailTransport` is the interface over both ways out:
 *
 *   `smtp`  — nodemailer, as before, for a deployment that has a relay;
 *   `graph` — Microsoft Graph, from a configurable sender mailbox, which is
 *             what an operator with a Microsoft 365 tenant already has.
 *
 * Which one is in force is a setting (`mail_channel_setting.transport`), not
 * an environment variable, so switching needs no deployment — and the
 * fallback is deliberate: a `graph` transport with no sender configured
 * falls back to SMTP rather than silently dropping an invoice.
 */

export type MailAttachment = {
    filename: string;
    /** A string is sent as UTF-8 — the XRechnung XML arrives that way. */
    content: Buffer | string;
    contentType?: string;
};

export type MailMessage = {
    from?: string;
    to: string | string[];
    cc?: string | string[];
    replyTo?: string;
    subject: string;
    text?: string;
    html?: string;
    attachments?: MailAttachment[];
};

export type SentMail = {
    /** The RFC 5322 Message-ID, where the transport reports one. */
    messageId: string | null;
};

export interface MailTransport {
    readonly id: "smtp" | "graph";
    sendMail(message: MailMessage): Promise<SentMail>;
}

/**
 * `family` is forwarded to net.connect at runtime but is absent from
 * @types/nodemailer, so it is declared here rather than casting the whole
 * options object and losing checking on the rest.
 */
type SmtpOptions = Parameters<typeof nodemailer.createTransport>[0] & {
    family?: 4 | 6;
};

/**
 * The name this server gives in EHLO. Nodemailer sends the machine's own
 * hostname and falls back to 127.0.0.1 when that is not a name anyone outside
 * knows — which is what Microsoft 365 saw in the header of the messages it
 * sorted as spam. An address rather than a name is fine there, but only as an
 * address literal (RFC 5321 §4.1.3): a bare 118.91.184.85 is neither a domain
 * nor a literal, and a receiving MTA is entitled to score it as a malformed
 * greeting. The brackets are added here so the variable can hold the plain
 * address, which is what anyone setting it would write.
 */
export function ehloName() {
    const value = process.env.VIRTIFY_SMTP_EHLO?.trim();

    if (!value || value.startsWith("[")) {
        return value || undefined;
    }

    if (value.includes(":")) {
        return `[IPv6:${value}]`;
    }

    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) ? `[${value}]` : value;
}

/**
 * Mail relay used for outbound notifications. The relay is reached on port 25
 * without authentication, so it is expected to be an internal host that
 * accepts mail from this server by address. Certificate validation is relaxed
 * because such relays commonly present an internal or self-signed
 * certificate — set this back to strict once the relay has a trusted one.
 */
export function smtpTransport(): MailTransport | null {
    const host = process.env.VIRTIFY_SMTP_HOST;

    if (!host) {
        return null;
    }

    const options: SmtpOptions = {
        host,
        port: 25,
        name: ehloName(),
        secure: false,
        auth: undefined,
        tls: { rejectUnauthorized: false },
        // TEMPORARY: force IPv4. Recipients such as Microsoft 365 reject mail
        // from an IPv6 address without a PTR record ("450 4.7.25 ... must have
        // reverse DNS record"), and nodemailer offers IPv4 and IPv6 addresses
        // together. Remove this once the sending host's IPv6 address has
        // reverse DNS — dual-stack delivery is the better end state.
        family: 4,
        // Without these a relay that swallows connections would hang the
        // request for roughly two minutes before nodemailer gives up.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    };

    const transport = nodemailer.createTransport(options);

    return {
        id: "smtp",
        async sendMail(message) {
            const sent = await transport.sendMail(message);

            return { messageId: sent.messageId ?? null };
        },
    };
}

/**
 * `Name <address@example.net>, other@example.net` → the bare addresses.
 * Graph wants them apart; nodemailer is the only one that parses the pair.
 */
export function addressList(value: string | string[] | undefined): string[] {
    if (!value) {
        return [];
    }

    return (Array.isArray(value) ? value : value.split(","))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const match = /<([^>]+)>/.exec(entry);

            return (match?.[1] ?? entry).trim().toLowerCase();
        })
        .filter((entry) => entry.includes("@"));
}

/**
 * The transport this installation uses right now.
 *
 * Resolved per call rather than cached in a module variable: the setting is
 * editable in the admin area, and a cached transport would keep sending
 * through the old one until the next deployment.
 */
export async function mailTransport(): Promise<MailTransport | null> {
    let config: Awaited<ReturnType<typeof loadMailChannelConfig>> | null = null;

    try {
        config = await loadMailChannelConfig();
    } catch (error) {
        // The settings table may not be reachable; SMTP still is.
        console.error("[mail] could not read the transport setting:", error);
    }

    if (config?.transport === "graph") {
        const channel = await mailChannel(config.id);
        const sender = config.outboundSender?.trim().toLowerCase();

        if (channel && sender) {
            return {
                id: "graph",
                async sendMail(message) {
                    const sent = await channel.send(sender, {
                        to: addressList(message.to).map((email) => ({ email })),
                        cc: addressList(message.cc).map((email) => ({ email })),
                        subject: message.subject,
                        html:
                            message.html ??
                            `<pre style="white-space:pre-wrap;">${message.text ?? ""}</pre>`,
                        text: message.text ?? "",
                        attachments: message.attachments?.map((entry) => ({
                            filename: entry.filename,
                            contentType:
                                entry.contentType ?? "application/octet-stream",
                            content:
                                typeof entry.content === "string"
                                    ? Buffer.from(entry.content, "utf8")
                                    : entry.content,
                        })),
                    });

                    return { messageId: sent.internetMessageId };
                },
            };
        }

        // Configured for Graph and unable to use it. SMTP is a better answer
        // than dropping an invoice on the floor; the admin page says which
        // one is actually in force.
        console.error(
            "[mail] the transport is set to graph but the channel or the sender mailbox is missing; falling back to SMTP",
        );
    }

    return smtpTransport();
}
