"use server";

import { createTransport, mailFrom } from "@/lib/mail";
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

function buildDeclaration(data: FormData, receivedAt: Date) {
    const extraordinary = read(data, "kind") === "ausserordentlich";

    return [
        `Kündigungserklärung an ${site.name}`,
        `Eingegangen am ${receivedAt.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })} (Europe/Berlin)`,
        "",
        `Art der Kündigung: ${extraordinary ? "Außerordentliche Kündigung" : "Ordentliche Kündigung"}`,
        extraordinary
            ? `Kündigungsgrund: ${read(data, "reason") || "—"}`
            : null,
        `Bezeichnung des Vertrags: ${read(data, "contract") || "—"}`,
        `Vertrags- oder Kundennummer: ${read(data, "number") || "—"}`,
        `Beendigung zum: ${read(data, "date") || "nächstmöglichen Zeitpunkt"}`,
        "",
        `Name: ${read(data, "name")}`,
        `Anschrift: ${read(data, "address")}`,
        `E-Mail für die Bestätigung: ${read(data, "email")}`,
    ]
        .filter(Boolean)
        .join("\n");
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

    const receivedAt = new Date();
    const declaration = buildDeclaration(data, receivedAt);
    const stamp = receivedAt.toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
    });

    const transport = createTransport();

    if (!transport) {
        console.error("VIRTIFY_SMTP_HOST is not set — cancellation not sent.");
        return {
            status: "error",
            declaration,
            message: `Die Erklärung konnte technisch nicht zugestellt werden. Bitte sende den unten stehenden Text an ${operator.email}; er gilt mit Zugang als fristwahrend.`,
        };
    }

    try {
        // The declaration itself.
        await transport.sendMail({
            from: mailFrom,
            to: operator.email,
            replyTo: email,
            subject: `Kündigung — ${read(data, "contract") || read(data, "number") || name}`,
            text: declaration,
        });

        // Confirmation of receipt owed to consumers under § 312k Abs. 5 BGB.
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
        });
    } catch (error) {
        console.error("Cancellation mail failed:", error);
        return {
            status: "error",
            declaration,
            message: `Die Erklärung konnte technisch nicht zugestellt werden. Bitte sende den unten stehenden Text an ${operator.email}; er gilt mit Zugang als fristwahrend.`,
        };
    }

    return { status: "sent", declaration, receivedAt: stamp };
}
