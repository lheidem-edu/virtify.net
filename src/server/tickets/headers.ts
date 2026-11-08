/**
 * Reading RFC 5322 headers, with no opinion about what they mean.
 *
 * Kept apart from the threading and the loop protection so both can be unit
 * tested against hand-written headers, which is the only way either is going
 * to be tested — there are no tenant credentials for this installation and
 * none are to be gone looking for.
 */

import type { MailHeaders } from "./channels/types";

/**
 * Message ids out of an `In-Reply-To` or `References` header.
 *
 * Both are lists of `<id>` tokens, in theory whitespace-separated and in
 * practice separated by whatever the sending client felt like — commas,
 * folded lines, nothing at all. So the angle brackets are the delimiter and
 * everything between them is one id, kept **with** its brackets because that
 * is how `Message-ID` arrives and the two are compared against each other.
 *
 * An id with no brackets at all (some old mailers) is taken as a single id
 * when the header holds nothing else.
 */
export function parseMessageIds(value: string | null | undefined): string[] {
    if (!value) {
        return [];
    }

    const bracketed = [...value.matchAll(/<([^<>]+)>/g)].map(
        (match) => `<${match[1].trim()}>`,
    );

    if (bracketed.length > 0) {
        return [...new Set(bracketed)];
    }

    const bare = value.trim();

    return bare && !bare.includes(" ") ? [`<${bare}>`] : [];
}

/** Normalises a Message-ID for storage and comparison: `<id>`, trimmed. */
export function normalizeMessageId(
    value: string | null | undefined,
): string | null {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();

    if (trimmed === "") {
        return null;
    }

    return trimmed.startsWith("<") && trimmed.endsWith(">")
        ? trimmed
        : `<${trimmed.replace(/^<|>$/g, "")}>`;
}

export function header(headers: MailHeaders, name: string): string | undefined {
    return headers[name.toLowerCase()];
}

/**
 * The subject with every reply and forward prefix taken off the front.
 *
 * Only used for display and for grouping, never for threading: a stripped
 * subject is far too weak a signal to join two conversations on, which is
 * why `resolveThread` does not look at it at all beyond the ticket tag.
 */
const PREFIXES =
    /^\s*(?:(?:re|aw|antw|antwort|fw|fwd|wg|weiterleitung|sv|vs|rif|tr)\s*(?:\[\d+\])?\s*:\s*)+/i;

export function baseSubject(subject: string): string {
    let previous = subject ?? "";
    let next = previous.replace(PREFIXES, "");

    // `Re: Fwd: Re:` needs more than one pass, and a subject made of nothing
    // but prefixes must not loop for ever.
    for (let i = 0; i < 10 && next !== previous; i += 1) {
        previous = next;
        next = previous.replace(PREFIXES, "");
    }

    return next.trim();
}
