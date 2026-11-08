import { htmlToText, sanitizeHtml } from "./sanitize";

/**
 * Taking the quoted history and the signature off a reply, for display only.
 *
 * Every rule here is a guess about somebody else's mail client, so the
 * original is **always kept** (`ticket_message.original_html` /
 * `original_text`) and the detail page can show it. A stripper that is
 * sometimes wrong and reversible is useful; one that is sometimes wrong and
 * destructive is not.
 *
 * The conservative bit worth stating: if stripping would leave nothing, the
 * whole body is kept instead. A reply that is one line under a quote is far
 * more common than a reply that is genuinely empty, and showing an empty
 * message in the queue is how a customer's question gets missed.
 */

/** `-- ` on a line of its own, RFC 3676 §4.3. The only standardised one. */
const SIGNATURE_DELIMITER = /^--\s?$/;

/**
 * Where a quoted history starts. Deliberately anchored to the start of a
 * line and deliberately narrow — the German and English wordings Outlook,
 * Gmail, Apple Mail and Thunderbird actually emit.
 */
const QUOTE_MARKERS: RegExp[] = [
    // Outlook, both languages, with and without the underscore rule.
    /^-{3,}\s*(Ursprüngliche Nachricht|Original Message|Urspr\. Nachricht)\s*-{3,}\s*$/i,
    /^_{10,}\s*$/,
    /^\s*Von:\s.+$/,
    /^\s*From:\s.+$/,
    // Gmail / Thunderbird / Apple Mail attribution lines.
    /^\s*Am\s.+\s(schrieb|um\s.+\sschrieb)\b.*:\s*$/i,
    /^\s*On\s.+\s(wrote|at\s.+\swrote)\b.*:\s*$/i,
    /^\s*.+\s<[^@\s>]+@[^@\s>]+>\s+(schrieb|wrote)\s*(am|on)?.*:\s*$/i,
    // Our own tag, when a client quotes the subject line back.
    /^\s*>{1,}\s*$/,
];

function isQuoteStart(line: string): boolean {
    return QUOTE_MARKERS.some((marker) => marker.test(line));
}

export type StrippedBody = {
    /** The new part. */
    text: string;
    /** Whether anything was actually removed. */
    strippedQuote: boolean;
    strippedSignature: boolean;
};

export function stripQuotedText(input: string): StrippedBody {
    const lines = input.replace(/\r\n/g, "\n").split("\n");

    let quoteAt = -1;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        if (isQuoteStart(line)) {
            quoteAt = i;
            break;
        }

        // A run of `>` quoting that reaches the end of the message. A single
        // quoted line in the middle of a reply is interleaved quoting and
        // must be kept, which is why this looks ahead rather than cutting at
        // the first `>`.
        if (/^\s*>/.test(line)) {
            const rest = lines.slice(i);
            const allQuoted = rest.every(
                (entry) => /^\s*>/.test(entry) || entry.trim() === "",
            );

            if (allQuoted) {
                quoteAt = i;
                break;
            }
        }
    }

    const body = quoteAt >= 0 ? lines.slice(0, quoteAt) : lines;

    let signatureAt = -1;

    for (let i = 0; i < body.length; i += 1) {
        if (SIGNATURE_DELIMITER.test(body[i])) {
            signatureAt = i;
            break;
        }
    }

    const kept = (signatureAt >= 0 ? body.slice(0, signatureAt) : body)
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (kept === "") {
        // Nothing survived. Rather than show an empty message, keep the
        // whole thing — see the header.
        return {
            text: input.replace(/\r\n/g, "\n").trim(),
            strippedQuote: false,
            strippedSignature: false,
        };
    }

    return {
        text: kept,
        strippedQuote: quoteAt >= 0,
        strippedSignature: signatureAt >= 0,
    };
}

/**
 * The HTML markers the big clients use to wrap a quoted history.
 *
 * Each of these is the *opening* of a block that runs to the end of the
 * message, so the cut is at the first one that appears and everything from
 * there on goes. Matching the closing tag would need a parser; a mail client
 * never puts the reply back underneath its own quote.
 */
const HTML_QUOTE_MARKERS: RegExp[] = [
    // Gmail.
    /<div\b[^>]*class="[^"]*\bgmail_quote\b[^"]*"[^>]*>/i,
    /<div\b[^>]*class="[^"]*\bgmail_extra\b[^"]*"[^>]*>/i,
    // Outlook desktop and Outlook Web.
    /<div\b[^>]*id="?divRplyFwdMsg"?[^>]*>/i,
    /<div\b[^>]*id="?appendonsend"?[^>]*>/i,
    /<div\b[^>]*style="[^"]*border(?:-top)?:\s*(?:solid|#?[0-9a-f]{3,6})[^"]*"[^>]*>\s*<(?:hr|b)\b/i,
    // Apple Mail.
    /<blockquote\b[^>]*type="?cite"?[^>]*>/i,
    // Thunderbird.
    /<div\b[^>]*class="[^"]*\bmoz-cite-prefix\b[^"]*"[^>]*>/i,
    // Our own: the marker every outbound reply carries, so a quoted copy of
    // one of our mails is recognised even by a client we have never seen.
    /<div\b[^>]*data-virtify-quote[^>]*>/i,
];

const HTML_SIGNATURE_MARKERS: RegExp[] = [
    /<div\b[^>]*class="[^"]*\bgmail_signature\b[^"]*"[^>]*>/i,
    /<div\b[^>]*id="?Signature"?[^>]*>/i,
    /<div\b[^>]*class="[^"]*\bmoz-signature\b[^"]*"[^>]*>/i,
];

export type StrippedHtml = {
    html: string;
    strippedQuote: boolean;
    strippedSignature: boolean;
};

export function stripQuotedHtml(input: string): StrippedHtml {
    let cut = input.length;
    let strippedQuote = false;

    for (const marker of HTML_QUOTE_MARKERS) {
        const match = marker.exec(input);

        if (match && (match.index ?? 0) < cut) {
            cut = match.index ?? 0;
            strippedQuote = true;
        }
    }

    let html = input.slice(0, cut);
    let strippedSignature = false;

    for (const marker of HTML_SIGNATURE_MARKERS) {
        const match = marker.exec(html);

        if (match) {
            html = html.slice(0, match.index ?? 0);
            strippedSignature = true;
        }
    }

    if (htmlToText(html).trim() === "") {
        return {
            html: input,
            strippedQuote: false,
            strippedSignature: false,
        };
    }

    return { html, strippedQuote, strippedSignature };
}

export type PreparedBody = {
    /** Sanitised, whole, exactly what arrived. */
    originalHtml: string | null;
    originalText: string;
    /** Sanitised and stripped — what the conversation shows. */
    displayHtml: string | null;
    displayText: string;
    stripped: boolean;
};

/**
 * The one entry point the pipeline uses: sanitise first, then strip.
 *
 * In that order on purpose. Stripping looks for markers in the markup, and
 * a message that got to decide what the stripper sees could hide its quoted
 * history behind a `<script>` the sanitiser would have removed afterwards —
 * leaving the display copy carrying markup nothing else in the system
 * expects.
 */
export function prepareBody(input: {
    html: string | null;
    text: string | null;
}): PreparedBody {
    const originalHtml = input.html ? sanitizeHtml(input.html) : null;
    const originalText = input.text?.replace(/\r\n/g, "\n").trim() ?? "";

    if (originalHtml) {
        const stripped = stripQuotedHtml(originalHtml);
        const displayText = stripQuotedText(htmlToText(stripped.html));

        return {
            originalHtml,
            originalText: originalText || htmlToText(originalHtml),
            displayHtml: stripped.html,
            displayText: displayText.text,
            stripped: stripped.strippedQuote || stripped.strippedSignature,
        };
    }

    const stripped = stripQuotedText(originalText);

    return {
        originalHtml: null,
        originalText,
        displayHtml: null,
        displayText: stripped.text,
        stripped: stripped.strippedQuote || stripped.strippedSignature,
    };
}
