import "server-only";
import nodemailer from "nodemailer";
import { operator, site } from "@/lib/site";

/**
 * Mail relay used for outbound notifications. The relay is reached on port 25
 * without authentication, so it is expected to be an internal host that
 * accepts mail from this server by address. Certificate validation is relaxed
 * because such relays commonly present an internal or self-signed
 * certificate — set this back to strict once the relay has a trusted one.
 */
export function createTransport() {
    const host = process.env.VIRTIFY_SMTP_HOST;

    if (!host) {
        return null;
    }

    return nodemailer.createTransport({
        host,
        port: 25,
        secure: false,
        auth: undefined,
        tls: { rejectUnauthorized: false },
        // Without these a relay that swallows connections would hang the
        // request for roughly two minutes before nodemailer gives up.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    });
}

/** Logs an SMTP failure with the relay's own response, which names the cause. */
export function logMailError(context: string, error: unknown) {
    const detail = error as {
        message?: string;
        code?: string;
        responseCode?: number;
        response?: string;
    };

    console.error(
        `[mail] ${context} failed:`,
        JSON.stringify({
            message: detail?.message,
            code: detail?.code,
            responseCode: detail?.responseCode,
            response: detail?.response,
        }),
    );
}

/** Every outbound mail is sent from, and delivered to, the operator address. */
export const mailFrom = operator.email;

export type EmailRow = { label: string; value: string };

export function escapeHtml(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Line breaks survive into HTML; the value is escaped first. */
function escapeMultiline(value: string) {
    return escapeHtml(value).replace(/\n/g, "<br />");
}

const FONT =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const INK = "#18181b";
const MUTED = "#52525b";
const FAINT = "#a1a1aa";
const LINE = "#e4e4e7";

/**
 * Transactional mail layout. Deliberately light rather than matching the
 * site's dark theme: these messages are legal records that people print, and
 * a dark background either prints as a black page or gets inverted by the
 * client. Tables and inline styles only — no external CSS, no flexbox.
 */
export function renderEmail(options: {
    preheader: string;
    heading: string;
    intro: string[];
    rowsTitle?: string;
    rows?: EmailRow[];
    outro?: string[];
}) {
    const paragraph = (text: string) =>
        `<p style="margin:0 0 14px;font:400 15px/1.65 ${FONT};color:${MUTED};">${escapeMultiline(text)}</p>`;

    const cell = `padding:10px 0;border-top:1px solid ${LINE};vertical-align:top;`;
    const row = (entry: EmailRow) => `
        <tr>
            <td style="${cell}width:38%;padding-right:20px;font:400 13px/1.5 ${FONT};color:${FAINT};">${escapeHtml(entry.label)}</td>
            <td style="${cell}font:400 13px/1.5 ${MONO};color:${INK};">${escapeMultiline(entry.value)}</td>
        </tr>`;

    const rowsBlock = options.rows?.length
        ? `
        ${options.rowsTitle ? `<p style="margin:26px 0 8px;font:600 13px/1.4 ${FONT};color:${INK};">${escapeHtml(options.rowsTitle)}</p>` : ""}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-bottom:1px solid ${LINE};">
            ${options.rows.map(row).join("")}
        </table>`
        : "";

    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(options.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};">
<tr>
<td style="padding:22px 32px;border-bottom:1px solid ${LINE};font:600 16px/1.2 ${FONT};color:${INK};letter-spacing:-0.01em;">virtify<span style="color:${FAINT};">.net</span></td>
</tr>
<tr>
<td style="padding:32px;">
<h1 style="margin:0 0 18px;font:600 21px/1.3 ${FONT};color:${INK};letter-spacing:-0.01em;">${escapeHtml(options.heading)}</h1>
${options.intro.map(paragraph).join("")}
${rowsBlock}
${options.outro?.length ? `<div style="margin-top:26px;">${options.outro.map(paragraph).join("")}</div>` : ""}
</td>
</tr>
<tr>
<td style="padding:18px 32px;border-top:1px solid ${LINE};font:400 12px/1.6 ${FONT};color:${FAINT};">
${escapeHtml(operator.name)} &middot; ${escapeHtml(operator.street)} &middot; ${escapeHtml(operator.city)}<br />
<a href="mailto:${operator.email}" style="color:${FAINT};">${operator.email}</a> &middot; <a href="${site.url}" style="color:${FAINT};">${site.name}</a>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}
