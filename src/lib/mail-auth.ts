import "server-only";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/lib/mail";
import { loadSettings } from "@/lib/settings";

/**
 * Account mails reuse the transactional layout from `mail.ts`, so the
 * verification and reset messages look like the cancellation receipts.
 */
async function send(options: {
    to: string;
    subject: string;
    heading: string;
    intro: string[];
    action: { label: string; url: string };
    outro: string[];
    context: string;
}) {
    const transport = createTransport();

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

    try {
        await transport.sendMail({
            from: await mailFrom(),
            to: options.to,
            subject: options.subject,
            text: [
                ...options.intro,
                "",
                `${options.action.label}: ${options.action.url}`,
                "",
                ...options.outro,
                "",
                `${site.name}`,
            ].join("\n"),
            html,
        });
    } catch (error) {
        logMailError(options.context, error);
        throw error;
    }
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
