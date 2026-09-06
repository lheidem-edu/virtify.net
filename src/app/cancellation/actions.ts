"use server";

import {
    createTransport,
    type EmailRow,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/lib/mail";
import { operator, site } from "@/lib/site";

export type CancellationState = {
    status: "idle" | "sent" | "error";
    declaration?: string;
    receivedAt?: string;
    message?: string;
};

function read(data: FormData, name: string) {
    return String(data.get(name) ?? "").trim();
}

function formatDate(value: string) {
    if (!value) {
        return "nächstmöglichen Zeitpunkt";
    }

    const parsed = new Date(`${value}T00:00:00Z`);

    return Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleDateString("de-DE", { timeZone: "UTC" });
}

/** One source for both the HTML rows and the plain-text record. */
function buildRows(data: FormData): EmailRow[] {
    const extraordinary = read(data, "kind") === "ausserordentlich";

    return [
        {
            label: "Art der Kündigung",
            value: extraordinary
                ? "Außerordentliche Kündigung"
                : "Ordentliche Kündigung",
        },
        ...(extraordinary
            ? [{ label: "Kündigungsgrund", value: read(data, "reason") || "—" }]
            : []),
        {
            label: "Bezeichnung des Vertrags",
            value: read(data, "contract") || "—",
        },
        {
            label: "Vertrags- oder Kundennummer",
            value: read(data, "number") || "—",
        },
        { label: "Beendigung zum", value: formatDate(read(data, "date")) },
        { label: "Name", value: read(data, "name") },
        { label: "Anschrift", value: read(data, "address") },
        {
            label: "E-Mail für die Bestätigung",
            value: read(data, "email"),
        },
    ];
}

function buildText(rows: EmailRow[], stamp: string) {
    return [
        `Kündigungserklärung an ${site.name}`,
        `Eingegangen am ${stamp} (Europe/Berlin)`,
        "",
        ...rows.map((row) => `${row.label}: ${row.value}`),
    ].join("\n");
}

export async function submitCancellation(
    _previous: CancellationState,
    data: FormData,
): Promise<CancellationState> {
    const email = read(data, "email");
    const name = read(data, "name");

    if (!email || !name) {
        return {
            status: "error",
            message: "Bitte Name und E-Mail-Adresse angeben.",
        };
    }

    const stamp = new Date().toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
    });
    const rows = buildRows(data);
    const declaration = buildText(rows, stamp);
    const subject = read(data, "contract") || read(data, "number") || name;

    const transport = createTransport();

    const failure = {
        status: "error" as const,
        declaration,
        message: `Die Erklärung konnte technisch nicht zugestellt werden. Bitte sende den unten stehenden Text an ${operator.email}; er gilt mit Zugang als fristwahrend.`,
    };

    if (!transport) {
        console.error("VIRTIFY_SMTP_HOST is not set — cancellation not sent.");
        return failure;
    }

    // The declaration itself. This one is what legally has to arrive.
    try {
        await transport.sendMail({
            from: mailFrom,
            to: operator.email,
            replyTo: email,
            subject: `Kündigung — ${subject}`,
            text: declaration,
            html: renderEmail({
                preheader: `Kündigung von ${name}, eingegangen am ${stamp}.`,
                heading: "Kündigung eingegangen",
                intro: [
                    `Über die Kündigungsschaltfläche auf ${site.name} ist am ${stamp} (Europe/Berlin) eine Kündigung eingegangen.`,
                ],
                rowsTitle: "Erklärung",
                rows,
                outro: [
                    "Eine Eingangsbestätigung wurde an die angegebene Adresse gesendet. Eine Antwort auf diese Nachricht geht direkt an den Kunden.",
                ],
            }),
        });
    } catch (error) {
        logMailError("cancellation notice", error);
        return failure;
    }

    // Confirmation of receipt owed to consumers under § 312k Abs. 5 BGB. Sent
    // separately: an internal relay may accept mail for the operator domain
    // but refuse to relay to an external recipient, and that must not make the
    // customer think the cancellation itself did not go through.
    try {
        await transport.sendMail({
            from: mailFrom,
            to: email,
            subject: `Eingangsbestätigung deiner Kündigung — ${site.name}`,
            text: [
                `Hallo ${name},`,
                "",
                `wir bestätigen den Eingang deiner Kündigung am ${stamp} (Europe/Berlin).`,
                "Die Kündigung wird zu dem gesetzlich oder vertraglich vorgesehenen Zeitpunkt wirksam; wir melden uns mit dem konkreten Beendigungsdatum.",
                "",
                "Deine Erklärung im Wortlaut:",
                "",
                declaration,
                "",
                `${site.name} — ${operator.name}, ${operator.street}, ${operator.city}`,
            ].join("\n"),
            html: renderEmail({
                preheader: `Eingegangen am ${stamp}. Wir melden uns mit dem Beendigungsdatum.`,
                heading: "Eingangsbestätigung deiner Kündigung",
                intro: [
                    `Hallo ${name},`,
                    `wir bestätigen den Eingang deiner Kündigung am ${stamp} (Europe/Berlin). Sie wird zu dem gesetzlich oder vertraglich vorgesehenen Zeitpunkt wirksam — wir melden uns mit dem konkreten Beendigungsdatum.`,
                ],
                rowsTitle: "Deine Erklärung im Wortlaut",
                rows,
                outro: [
                    "Bewahre diese Nachricht als Nachweis auf. Wenn etwas nicht stimmt, antworte einfach auf diese E-Mail.",
                ],
            }),
        });
    } catch (error) {
        // The cancellation is recorded; only the receipt did not go out.
        logMailError("receipt confirmation", error);
    }

    return { status: "sent", declaration, receivedAt: stamp };
}
