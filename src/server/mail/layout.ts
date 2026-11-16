import "server-only";
import type { Locale } from "@/i18n/locale";
import { loadSettings, type Settings } from "@/server/settings";

/**
 * The transactional mail layout.
 *
 * Split out of `./index.ts` in Phase 9 so a template module can import the
 * layout without dragging the transport — and with it nodemailer and the
 * Graph channel — into every process that only wants to *render* a message.
 *
 * There is one layout and there will be one. The build plan named
 * `react-email` here; it is not used, and the reason is the same one that
 * gives this codebase a single pricing function and a single settlement: a
 * second renderer for the same thing is a second answer to "what does our
 * mail look like", and the one that is wrong is the one somebody sees. The
 * deviation is recorded in CLAUDE.md with this reason beside it.
 */

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
export type EmailLayoutOptions = {
    preheader: string;
    heading: string;
    intro: string[];
    /** Primary call to action, rendered between the intro and the rows. */
    action?: { label: string; url: string };
    rowsTitle?: string;
    rows?: EmailRow[];
    outro?: string[];
    /** Goes into `<html lang>`, so a screen reader reads it correctly. */
    locale?: Locale;
};

/**
 * The synchronous form, for a caller that already holds the settings — the
 * outbox loads them once per sweep rather than once per mail.
 */
export function renderEmailWith(
    settings: Settings,
    options: EmailLayoutOptions,
) {
    const { operator, site } = settings;

    const paragraph = (text: string) =>
        `<p style="margin:0 0 14px;font:400 15px/1.65 ${FONT};color:${MUTED};">${escapeMultiline(text)}</p>`;

    const cell = `padding:10px 0;border-top:1px solid ${LINE};vertical-align:top;`;
    const row = (entry: EmailRow) => `
        <tr>
            <td style="${cell}width:38%;padding-right:20px;font:400 13px/1.5 ${FONT};color:${FAINT};">${escapeHtml(entry.label)}</td>
            <td style="${cell}font:400 13px/1.5 ${MONO};color:${INK};">${escapeMultiline(entry.value)}</td>
        </tr>`;

    // A table-wrapped anchor rather than a styled <a>: Outlook ignores
    // padding on inline elements, which would collapse the button to text.
    const actionBlock = options.action
        ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0;">
            <tr>
                <td style="background:${INK};border-radius:10px;">
                    <a href="${escapeHtml(options.action.url)}" style="display:inline-block;padding:13px 22px;font:500 14px/1 ${FONT};color:#ffffff;text-decoration:none;">${escapeHtml(options.action.label)}</a>
                </td>
            </tr>
        </table>`
        : "";

    const rowsBlock = options.rows?.length
        ? `
        ${options.rowsTitle ? `<p style="margin:26px 0 8px;font:600 13px/1.4 ${FONT};color:${INK};">${escapeHtml(options.rowsTitle)}</p>` : ""}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-bottom:1px solid ${LINE};">
            ${options.rows.map(row).join("")}
        </table>`
        : "";

    return `<!doctype html>
<html lang="${options.locale ?? "de"}">
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
${actionBlock}
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

/**
 * The form every caller that predates Phase 9 uses: loads the settings
 * itself. Kept so those call sites did not all have to change in the same
 * commit that introduced the outbox.
 */
export async function renderEmail(options: EmailLayoutOptions) {
    return renderEmailWith(await loadSettings(), options);
}
