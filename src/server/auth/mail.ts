import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/db";
import {
    logMailError,
    mailFrom,
    mailTransport,
    renderEmail,
} from "@/server/mail";
import { recordMail } from "@/server/mail/outbox";
import type { DirectMailId } from "@/server/mail/templates/direct";
import { loadSettings } from "@/server/settings";

/**
 * Account mails reuse the transactional layout from `mail.ts`, so the
 * verification and reset messages look like the cancellation receipts.
 *
 * ## Why these are not in the outbox
 *
 * They are the `direct` half of the catalogue (`mail/templates/direct.ts`):
 * the send has to happen inside the request that asked for it, because
 * Better Auth reports success to the person the moment this returns and the
 * page then says "wir haben dir eine E-Mail geschickt". A queued mail would
 * make that sentence a guess, and an account could sit behind a mail that
 * never went with nobody any the wiser.
 *
 * So they send first and **record afterwards**, with `recordMail`, which is
 * the same table and the same key shape as a queued one — so the admin log
 * is complete and there is one place that answers "did this person ever get
 * anything from us".
 *
 * The key is a hash of the token in the link. A genuine "send it again"
 * mints a fresh token and is a different key, and goes out; the same request
 * arriving twice — a double-submitted form, a proxy replaying a POST —
 * carries the same token and is recorded once. It is **hashed** because
 * `email_log` is readable by anyone with `notifications.read`, and a
 * verification token sitting in a log column is a login.
 */
async function send(options: {
    to: string;
    subject: string;
    heading: string;
    intro: string[];
    action: { label: string; url: string };
    outro: string[];
    context: string;
    /** Which of the direct templates this is, for the log. */
    template: DirectMailId;
}) {
    const transport = await mailTransport();

    if (!transport) {
        // Throwing keeps Better Auth from reporting success for a mail that
        // was never sent — the caller surfaces it as a failed request.
        throw new Error(
            "VIRTIFY_SMTP_HOST is not set; cannot send account mail",
        );
    }

    const html = await renderEmail({
        preheader: options.intro[options.intro.length - 1] ?? options.heading,
        heading: options.heading,
        intro: options.intro,
        action: options.action,
        outro: options.outro,
    });

    const { site } = await loadSettings();

    const text = [
        ...options.intro,
        "",
        `${options.action.label}: ${options.action.url}`,
        "",
        ...options.outro,
        "",
        `${site.name}`,
    ].join("\n");

    const dedupeKey = `token:${tokenFingerprint(options.action.url)}`;

    try {
        const sent = await transport.sendMail({
            from: await mailFrom(),
            to: options.to,
            subject: options.subject,
            text,
            html,
        });

        /**
         * The mail is with the person; this is only the record of it. A
         * recording that fails must not fail the request — the link works
         * either way — so it is logged and swallowed, which is the opposite
         * of the send above and deliberately so.
         */
        try {
            await recordMail(db, {
                template: options.template,
                dedupeKey,
                toEmail: options.to,
                subject: options.subject,
                bodyText: text,
                outcome: {
                    sent: true,
                    messageId: sent.messageId,
                    transport: transport.id,
                },
            });
        } catch (error) {
            console.error("[mail] could not record the account mail:", error);
        }

        return;
    } catch (error) {
        logMailError(options.context, error);

        try {
            await recordMail(db, {
                template: options.template,
                dedupeKey,
                toEmail: options.to,
                subject: options.subject,
                bodyText: text,
                outcome: {
                    sent: false,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
        } catch (recordError) {
            console.error(
                "[mail] could not record the failed account mail:",
                recordError,
            );
        }

        throw error;
    }
}

/**
 * A stable, non-reversible name for the link in this mail.
 *
 * SHA-256 of the whole URL, truncated. The token is the only part of the URL
 * that varies between two sends to the same person, so hashing the URL is
 * hashing the token — and nothing in the log can be turned back into a
 * working link. Truncated to 32 hex characters, which is 128 bits: far more
 * than enough for a key whose job is to tell two sends apart.
 */
function tokenFingerprint(url: string): string {
    return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

export async function sendVerificationMail({
    to,
    name,
    url,
    heading = "E-Mail-Adresse bestätigen",
}: {
    to: string;
    name?: string | null;
    url: string;
    heading?: string;
}) {
    const { site } = await loadSettings();
    await send({
        to,
        context: "verification mail",
        template: "account.verify",
        subject: `${heading} — ${site.name}`,
        heading,
        intro: [
            name ? `Hallo ${name},` : "Hallo,",
            `bitte bestätige deine E-Mail-Adresse, um dein Konto bei ${site.name} zu aktivieren.`,
        ],
        action: { label: "E-Mail-Adresse bestätigen", url },
        outro: [
            "Der Link ist aus Sicherheitsgründen nur begrenzt gültig. Wenn du dich nicht registriert hast, kannst du diese Nachricht ignorieren — ohne Bestätigung passiert nichts.",
        ],
    });
}

export async function sendPasswordResetMail({
    to,
    name,
    url,
}: {
    to: string;
    name?: string | null;
    url: string;
}) {
    const { site } = await loadSettings();
    await send({
        to,
        context: "password reset mail",
        template: "account.reset",
        subject: `Passwort zurücksetzen — ${site.name}`,
        heading: "Passwort zurücksetzen",
        intro: [
            name ? `Hallo ${name},` : "Hallo,",
            "für dein Konto wurde ein neues Passwort angefordert.",
        ],
        action: { label: "Neues Passwort setzen", url },
        outro: [
            "Der Link ist aus Sicherheitsgründen nur begrenzt gültig. Wenn die Anfrage nicht von dir stammt, ändert sich nichts — dein bisheriges Passwort bleibt gültig.",
        ],
    });
}

export async function sendStaffInviteMail({
    to,
    name,
    url,
}: {
    to: string;
    name?: string | null;
    url: string;
}) {
    const { site } = await loadSettings();
    await send({
        to,
        context: "staff invite mail",
        template: "staff.invite",
        subject: `Zugang zur Verwaltung — ${site.name}`,
        heading: "Zugang einrichten",
        intro: [
            name ? `Hallo ${name},` : "Hallo,",
            `für dich wurde ein Mitarbeiterzugang zur Verwaltung von ${site.name} angelegt. Vergib über den folgenden Link dein Passwort, danach kannst du dich unter ${site.url}/admin anmelden.`,
        ],
        action: { label: "Passwort festlegen", url },
        outro: [
            "Der Link ist aus Sicherheitsgründen nur begrenzt gültig; ist er abgelaufen, fordere über „Passwort vergessen“ einen neuen an.",
            "Der Zugang hat Zugriff auf Kundendaten und ist von einem etwaigen Kundenkonto unter derselben Adresse getrennt. Beim ersten Anmelden richtest du die Zwei-Faktor-Anmeldung ein; ohne sie bleibt die Verwaltung gesperrt.",
        ],
    });
}

export async function sendStaffResetMail({
    to,
    name,
    url,
}: {
    to: string;
    name?: string | null;
    url: string;
}) {
    const { site } = await loadSettings();
    await send({
        to,
        context: "staff password reset mail",
        template: "staff.reset",
        subject: `Passwort für die Verwaltung zurücksetzen — ${site.name}`,
        heading: "Passwort zurücksetzen",
        intro: [
            name ? `Hallo ${name},` : "Hallo,",
            "für deinen Mitarbeiterzugang zur Verwaltung wurde ein neues Passwort angefordert. Das Passwort deines Kundenkontos ist davon nicht betroffen — es sind getrennte Zugänge.",
        ],
        action: { label: "Neues Passwort setzen", url },
        outro: [
            "Der Link ist aus Sicherheitsgründen nur begrenzt gültig. Wenn die Anfrage nicht von dir stammt, ändert sich nichts — dein bisheriges Passwort bleibt gültig.",
        ],
    });
}
