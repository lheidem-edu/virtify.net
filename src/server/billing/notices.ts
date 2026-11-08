import "server-only";
import type { DunningLevel } from "@/db/schema";
import { formatPrice } from "@/lib/format";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/server/mail";
import { loadSettings } from "@/server/settings";
import { dunningMessage } from "./dunning";

/**
 * What the recurring run says to people.
 *
 * Kept apart from `./run.ts` for the reason `settle.ts` is kept apart from
 * `apply.ts`: a transaction holds row locks, and a mail relay that hangs
 * would hold them with it. Nothing here is called from inside a
 * transaction, and nothing here throws — a notice that could not be sent
 * must not roll back the suspension it was announcing, because the
 * suspension is the part that is true.
 *
 * There is no SMTP relay configured on this installation yet, so in practice
 * these land in the log. That is deliberate rather than forgotten: the run
 * records what it did in `dunning_action` either way, and `notified` says
 * whether the customer actually heard about it.
 */

async function send(input: {
    to: string;
    subject: string;
    lines: string[];
    heading: string;
    action?: { label: string; url: string };
    rows: { label: string; value: string }[];
}): Promise<boolean> {
    const transport = createTransport();

    if (!transport) {
        console.error(`[billing] ${input.subject} — no mail transport`);
        return false;
    }

    try {
        await transport.sendMail({
            from: await mailFrom(),
            to: input.to,
            subject: input.subject,
            text: input.lines.join("\n"),
            html: await renderEmail({
                preheader: input.lines[0] ?? input.subject,
                heading: input.heading,
                intro: input.lines,
                ...(input.action ? { action: input.action } : {}),
                rowsTitle: "Eckdaten",
                rows: input.rows,
            }),
        });

        return true;
    } catch (error) {
        logMailError(input.subject, error);
        return false;
    }
}

/** A dunning notice. The wording itself is pure — see `./dunning.ts`. */
export async function sendDunningNotice(input: {
    to: string;
    level: DunningLevel;
    invoiceId: string;
    invoiceNumber: string;
    amountCents: number;
    dueAt: Date;
    feeCents?: number;
}): Promise<boolean> {
    const { site } = await loadSettings();
    const message = dunningMessage({
        level: input.level,
        invoiceNumber: input.invoiceNumber,
        amountCents: input.amountCents,
        formatted: formatPrice(input.amountCents),
        dueAt: input.dueAt,
    });

    return send({
        to: input.to,
        subject: message.subject,
        lines: [
            ...message.lines,
            ...(input.feeCents
                ? [
                      `Für die Mahnung berechnen wir eine Gebühr von ${formatPrice(input.feeCents)}; sie wird gesondert in Rechnung gestellt.`,
                  ]
                : []),
        ],
        heading: message.subject,
        action: {
            label: "Rechnung öffnen",
            url: `${site.url}/client/invoices/${input.invoiceId}`,
        },
        rows: [
            { label: "Rechnung", value: input.invoiceNumber },
            { label: "Betrag", value: formatPrice(input.amountCents) },
            ...(input.feeCents
                ? [{ label: "Mahngebühr", value: formatPrice(input.feeCents) }]
                : []),
        ],
    });
}

/** "Ihre Testphase endet" — sent when the free days run out. */
export async function sendTrialEndingNotice(input: {
    to: string;
    subscriptionId: string;
    label: string;
    amountCents: number;
    chargeAt: Date;
}): Promise<boolean> {
    const { site } = await loadSettings();
    const day = new Intl.DateTimeFormat("de-DE", {
        dateStyle: "long",
        timeZone: "Europe/Berlin",
    }).format(input.chargeAt);

    return send({
        to: input.to,
        subject: `Ihre Testphase endet am ${day}`,
        lines: [
            `Die kostenlose Testphase für „${input.label}“ endet am ${day}.`,
            `Danach wird ${formatPrice(input.amountCents)} je Zeitraum berechnet. Wenn Sie nicht weitermachen möchten, kündigen Sie bitte vorher im Kundenbereich.`,
        ],
        heading: "Ihre Testphase endet",
        action: {
            label: "Abo öffnen",
            url: `${site.url}/client/subscriptions/${input.subscriptionId}`,
        },
        rows: [
            { label: "Abo", value: input.label },
            { label: "Ende der Testphase", value: day },
            { label: "Danach", value: formatPrice(input.amountCents) },
        ],
    });
}

/** "Ihre Verlängerung steht an" — the renewal invoice has been issued. */
export async function sendRenewalNotice(input: {
    to: string;
    invoiceId: string;
    invoiceNumber: string;
    amountCents: number;
    dueAt: Date;
    autoCharge: boolean;
}): Promise<boolean> {
    const { site } = await loadSettings();
    const day = new Intl.DateTimeFormat("de-DE", {
        dateStyle: "long",
        timeZone: "Europe/Berlin",
    }).format(input.dueAt);

    return send({
        to: input.to,
        subject: `Verlängerung — Rechnung ${input.invoiceNumber}`,
        lines: [
            `Für den nächsten Abrechnungszeitraum haben wir die Rechnung ${input.invoiceNumber} über ${formatPrice(input.amountCents)} ausgestellt. Sie ist am ${day} fällig.`,
            input.autoCharge
                ? "Wir ziehen den Betrag an diesem Tag von Ihrem hinterlegten Zahlungsmittel ein; Sie müssen nichts weiter tun."
                : "Bitte gleichen Sie den Betrag bis dahin aus.",
        ],
        heading: "Ihre Verlängerung",
        action: {
            label: "Rechnung öffnen",
            url: `${site.url}/client/invoices/${input.invoiceId}`,
        },
        rows: [
            { label: "Rechnung", value: input.invoiceNumber },
            { label: "Betrag", value: formatPrice(input.amountCents) },
            { label: "Fällig am", value: day },
        ],
    });
}
