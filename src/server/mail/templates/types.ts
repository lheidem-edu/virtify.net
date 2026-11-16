import type { z } from "zod";
import type { Locale } from "@/i18n/locale";
import type { Messages } from "@/i18n/messages";
import type { EmailRow } from "@/server/mail/layout";
import type { Settings } from "@/server/settings";

/**
 * What a transactional message is, as a value.
 *
 * A template is **pure**: it takes a payload and a locale and returns the
 * pieces of a message. It is handed no database, no transport and no clock,
 * so a template cannot settle an invoice, move a subscription or touch a
 * machine — which is the rule the whole event bus is built around, enforced
 * by the type rather than by a comment (see `src/server/events/catalog.ts`).
 *
 * The attachments resolver is the one thing that reaches outside, and it is
 * deliberately crippled: it returns storage *keys*, and the outbox fetches
 * them. It cannot render a PDF. A finalized invoice's bytes are written once
 * and kept (CLAUDE.md), so a mail about one never needs a renderer — which is
 * also what lets the worker send it, since `@react-pdf/renderer` cannot even
 * be imported there.
 */

export type MailDelivery =
    /**
     * Queued as an `email_log` row and sent by the sweep. Everything
     * event-driven is this: the sender is a background pass, nobody is
     * waiting on the response, and a failure gets a retry ladder.
     */
    | "outbox"
    /**
     * Sent inside the request that asked for it, then recorded. For the
     * handful of mails whose failure the *user* has to see in the same
     * request — a verification link, a password reset — because telling
     * somebody "check your inbox" for a mail that was only queued is how an
     * account gets stuck behind a mail that never went.
     */
    | "direct";

export type RenderedMail = {
    subject: string;
    heading: string;
    /** The paragraph above the button. */
    intro: string[];
    action?: { label: string; url: string };
    rowsTitle?: string;
    rows: EmailRow[];
    outro: string[];
};

/**
 * A translator, loosened to accept a key built at runtime.
 *
 * Several templates pick their wording by a value in the payload — the
 * dunning rung, the reason a service was suspended — and `use-intl`'s own
 * type only admits literal keys, so a `${level}.subject` would not compile.
 * The checking that replaces it is stronger than the type was: the
 * translator is built with `onError` throwing (see `src/i18n/messages.ts`),
 * and `tests/unit/mail-templates.test.ts` renders **every template in both
 * languages with every branch of every discriminator**. A key that is
 * missing from either catalogue fails the suite rather than shipping
 * `mail.welcome.intro2` into somebody's inbox.
 */
export type MailText = (
    key: string,
    values?: Record<string, string | number | Date>,
) => string;

export type TemplateContext = {
    locale: Locale;
    settings: Settings;
    /** Namespaced translators, so a template cannot reach the portal's copy. */
    t: MailText;
    labels: MailText;
    common: MailText;
};

export type MailAttachmentRef = {
    /** A key in `DocumentStorage`. Fetched, never rendered. */
    key: string;
    filename: string;
    contentType: string;
};

export type MailTemplate<P> = {
    id: string;
    delivery: MailDelivery;
    /**
     * Whether „erneut senden" makes sense. A verification link does not: the
     * token is single-use and time-limited, and the person asks for a new one
     * themselves. A notice about an invoice does.
     */
    resendable: boolean;
    payload: z.ZodType<P>;
    render(payload: P, context: TemplateContext): RenderedMail;
    attachments?(payload: P): MailAttachmentRef[];
};

/**
 * Narrows a template's payload type away so the catalogue can be one map.
 *
 * The catalogue is heterogeneous by nature — thirteen templates with thirteen
 * payloads — and every entry is parsed through its own zod schema before
 * `render` is called, which is where the type is re-established. That parse is
 * the check this `any` gives up on, and it is a stronger one: it runs.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above — the zod parse in renderMailRow re-establishes the type at runtime
export type AnyMailTemplate = MailTemplate<any>;

export type MessageNamespace = keyof Messages;
