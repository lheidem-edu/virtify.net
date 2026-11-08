import type { InboundMessage } from "./channels/types";
import { header } from "./headers";

/**
 * Loop protection.
 *
 * A ticket system that mails back whatever it is mailed, into a mailbox that
 * receives its own outbound copies, is a thing that generates its own input.
 * Phase 6 shipped the billing version of this — a Mahngebühr that was dunned,
 * raised another fee and did it for ever — and the mail version is worse,
 * because the other end is somebody else's autoresponder and the two of them
 * will keep each other busy all weekend.
 *
 * Two different decisions live here and they are deliberately separate:
 *
 *   `classifyInbound` — may this message become a ticket message at all?
 *   `isAutomated`     — may we *reply automatically* to it?
 *
 * An out-of-office is worth filing against the ticket and is never worth
 * answering. Our own outbound copy is worth neither.
 */

export type IgnoreReason =
    | "own-outbound"
    | "own-mailbox"
    | "auto-submitted"
    | "auto-response-suppressed"
    | "bounce"
    | "draft"
    | "no-sender";

export type InboundVerdict =
    | { kind: "accept"; automated: boolean }
    | { kind: "ignore"; reason: IgnoreReason; automated: boolean };

export type LoopContext = {
    /** Every address this installation sends from, lower-cased. */
    ownAddresses: readonly string[];
    /**
     * Whether we have a record of having sent this exact Message-ID.
     * Resolved by the caller against `ticket_message`, because the answer is
     * a query and this function is pure.
     */
    isOwnOutbound: boolean;
};

/**
 * RFC 3834: `Auto-Submitted: no` — or no header at all — is a message a
 * human sent. Anything else (`auto-generated`, `auto-replied`,
 * `auto-notified`) was sent by a program.
 */
export function autoSubmitted(message: InboundMessage): boolean {
    const value = header(message.headers, "auto-submitted");

    if (!value) {
        return false;
    }

    return value.split(";")[0].trim().toLowerCase() !== "no";
}

/**
 * Microsoft's own marker. `X-Auto-Response-Suppress: All` on a message means
 * *do not answer this*, and Exchange sets it on everything it generates.
 * Any value but an empty one is a request not to reply; the list form
 * (`OOF, DR, RN, NRN, AutoReply`) is as good as `All` for our purposes,
 * because every member of it is a class of automatic reply.
 */
export function autoResponseSuppressed(message: InboundMessage): boolean {
    const value = header(message.headers, "x-auto-response-suppress");

    return Boolean(value && value.trim() !== "");
}

/**
 * A delivery status notification. Three independent signals, because no
 * single one is reliable: the null envelope sender RFC 3464 requires, the
 * `Content-Type` of a DSN, and the headers Exchange and Postfix add.
 */
export function isBounce(message: InboundMessage): boolean {
    const returnPath = header(message.headers, "return-path")?.trim();

    if (returnPath === "<>" || returnPath === "") {
        return true;
    }

    const contentType = header(message.headers, "content-type") ?? "";

    if (
        /multipart\/report/i.test(contentType) &&
        /report-type\s*=\s*"?(delivery-status|disposition-notification)"?/i.test(
            contentType,
        )
    ) {
        return true;
    }

    if (header(message.headers, "x-failed-recipients")) {
        return true;
    }

    const from = message.from?.email ?? "";

    return (
        from.startsWith("postmaster@") ||
        from.startsWith("mailer-daemon@") ||
        // The fixed local part Exchange Online sends its NDRs from.
        from.startsWith("microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@")
    );
}

/**
 * Whether anything automatic may be sent in answer to this message.
 * `precedence: bulk|list|junk` is the convention mailing lists use, and it
 * predates RFC 3834 by twenty years.
 */
export function isAutomated(message: InboundMessage): boolean {
    const precedence = (
        header(message.headers, "precedence") ?? ""
    ).toLowerCase();

    return (
        autoSubmitted(message) ||
        autoResponseSuppressed(message) ||
        isBounce(message) ||
        ["bulk", "list", "junk"].includes(precedence.trim()) ||
        Boolean(header(message.headers, "list-unsubscribe"))
    );
}

/**
 * What to do with an inbound message.
 *
 * Our own outbound copy is refused first and on the strongest evidence
 * there is — the Message-ID we recorded when we sent it. The address check
 * underneath it catches the case the id cannot: a reply sent from the
 * mailbox by a member of staff using Outlook, which this system never saw.
 */
export function classifyInbound(
    message: InboundMessage,
    context: LoopContext,
): InboundVerdict {
    const automated = isAutomated(message);

    if (message.isDraft) {
        return { kind: "ignore", reason: "draft", automated };
    }

    if (context.isOwnOutbound) {
        return { kind: "ignore", reason: "own-outbound", automated };
    }

    const from = message.from?.email?.toLowerCase() ?? "";
    const sender = message.sender?.email?.toLowerCase() ?? "";

    if (!from && !sender) {
        return { kind: "ignore", reason: "no-sender", automated };
    }

    const own = context.ownAddresses.map((entry) => entry.toLowerCase());

    if (own.includes(from) || (sender !== "" && own.includes(sender))) {
        return { kind: "ignore", reason: "own-mailbox", automated };
    }

    if (isBounce(message)) {
        /**
         * A bounce is filed nowhere and answered never. It is not a
         * customer's message, and treating it as one opens a ticket
         * addressed to an address that has just been proved undeliverable —
         * which is the first step of a loop with the far side's postmaster.
         */
        return { kind: "ignore", reason: "bounce", automated: true };
    }

    if (autoSubmitted(message)) {
        return { kind: "ignore", reason: "auto-submitted", automated: true };
    }

    if (autoResponseSuppressed(message)) {
        return {
            kind: "ignore",
            reason: "auto-response-suppressed",
            automated: true,
        };
    }

    return { kind: "accept", automated };
}

export const IGNORE_REASON_LABEL: Record<IgnoreReason, string> = {
    "own-outbound": "Eigene ausgehende Nachricht",
    "own-mailbox": "Absender ist ein eigenes Postfach",
    "auto-submitted": "Automatisch erzeugt (Auto-Submitted)",
    "auto-response-suppressed":
        "Automatische Antwort (X-Auto-Response-Suppress)",
    bounce: "Unzustellbarkeitsnachricht",
    draft: "Entwurf im Postfach",
    "no-sender": "Ohne Absender",
};

/**
 * The headers every message this system sends has to carry, so the far side
 * — and our own next pass — can tell it apart from a person's mail.
 *
 * Graph only accepts custom headers whose name starts with `x-`, which is
 * why `Auto-Submitted` is absent from the outbound side and the recognition
 * above leans on the Message-ID we recorded instead.
 */
export const OUTBOUND_MARKER_HEADER = "x-virtify-ticket";
