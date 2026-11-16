/**
 * The mails that are sent inside the request that asked for them.
 *
 * These are **not** templates in the sense of `./index.ts`: the caller
 * renders them itself and `recordMail()` writes down that it did. They are
 * listed here so the admin log can name them, and so there is one place that
 * answers "is this id a mail this installation sends".
 *
 * Two reasons a mail is here rather than in the outbox:
 *
 *  - **Its failure has to reach the person in the same request.** A
 *    verification link, a password reset, a staff invitation. Telling
 *    somebody "check your inbox" for a mail that was only queued is how an
 *    account gets stuck behind a mail that never went, and Better Auth wants
 *    the send to throw so the request can fail.
 *  - **It carries a document the sender has just rendered.** An offer, an
 *    invoice with its XRechnung, a Rechnungskorrektur. The outbox can
 *    *fetch* a stored PDF but never render one, which is deliberate — it is
 *    what lets the worker send mail at all, since `@react-pdf/renderer`
 *    cannot be imported there. An operator pressing „senden" is in a web
 *    process that can.
 *
 * None of them is resendable *through the outbox*: there is no stored payload
 * to render them from, and for the document mails the right repeat is the
 * admin action that renders the document again — one document-sending path,
 * not two.
 */
export const DIRECT_MAIL_LABELS = {
    "account.verify": "E-Mail-Adresse bestätigen",
    "account.reset": "Passwort zurücksetzen",
    "account.change_email": "Neue E-Mail-Adresse bestätigen",
    "staff.invite": "Mitarbeiterzugang",
    "staff.reset": "Passwort Verwaltung",
    "offer.document": "Angebot versendet",
    "offer.withdrawn": "Angebot zurückgezogen",
    "offer.accepted": "Angebot angenommen",
    "invoice.document": "Rechnung versendet",
    "creditnote.document": "Korrektur versendet",
    "contract.terminated": "Kündigungsbestätigung",
    "legal.change": "Änderung der Rechtstexte",
    "operator.notice": "Hinweis an den Betreiber",
} as const;

export type DirectMailId = keyof typeof DIRECT_MAIL_LABELS;

export const DIRECT_MAIL_IDS = Object.keys(
    DIRECT_MAIL_LABELS,
) as DirectMailId[];

export function isDirectMailId(value: unknown): value is DirectMailId {
    return typeof value === "string" && value in DIRECT_MAIL_LABELS;
}
