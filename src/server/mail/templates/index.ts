import { z } from "zod";
import { formatLongDateIn, formatPriceIn } from "@/lib/format";
import { dunningMessage } from "@/server/billing/dunning";
import type {
    AnyMailTemplate,
    MailTemplate,
    RenderedMail,
    TemplateContext,
} from "./types";

/**
 * Every transactional message this installation sends, and what each one is
 * keyed on.
 *
 * ## What `email_log (template, to_email, dedupe_key)` speaks for
 *
 * **One message to one address about one cause.** Not one attempt, not one
 * job, not one pass of a sweep. The caller says which cause it is, and every
 * caller's key is in the table below — written out because Phase 6 shipped a
 * day-scoped claim taken by a customer-scoped pass and Phase 7 shipped a
 * per-mailbox claim behind an installation-wide unique index, and both times
 * the defect was this question answered carelessly.
 *
 * | template | key | what makes it right |
 * |---|---|---|
 * | `welcome` | `customer:<id>` | An account is opened once, for ever, so there is one welcome however often the registration is retried. |
 * | `order.confirmed` | `order:<id>` | `placeOrder()` takes the cart `FOR UPDATE`, so a double submit is one order and therefore one confirmation. |
 * | `invoice.notice` | `invoice:<id>` | An invoice is finalized once and never again (rule 3). Its id is the notice. **Not** the subscription and the period: a Rechnungskorrektur plus a re-issue is a second document and deserves a second mail. |
 * | `payment.received` | `payment:<id>` | One payment, one receipt. A webhook delivered twice settles once (rule 7), and both deliveries emit the same key. |
 * | `payment.action_required` | `payment:<id>` | The attempt row is written under a reference *we* generated before the gateway was called, so the id is that attempt. A collection retried tomorrow is a new attempt and a new mail — which is right: the customer needs the new link, the old one is spent. |
 * | `payment.failed` | `payment:<id>` | The same. |
 * | `dunning` | `dunning:<dunning_action id>` | The rung is already claimed under `dunning_action (invoice_id, level)`, so that row **is** one rung, once. Keying on the invoice and the level would spell the same claim twice and let the two disagree. |
 * | `subscription.trial_ending` | `subscription:<id>:trial:<trial end, ISO>` | The same end seen on two passes is one notice; an end moved by a plan change is a different one and the customer has to hear about it again. The date is in the key for exactly that reason — the subscription id alone would silence the second notice for ever. |
 * | `subscription.ended` | `subscriptionevent:<id>` | `transitionSubscriptionIn` mints the event id inside the transaction that writes the status, so it is unique per occurrence: ended, revived by a payment and ended again is two. |
 * | `service.activated` / `.suspended` / `.terminated` | `service:<id>:<cause>` | The cause is the status change `applyServiceFollow` was handed — the subscription event, the dunning action — and the service id is in front of it because one cause moves several machines and each gets its own line. Identical to the request key the module call runs under, on purpose: one cause, one machine, one mail. |
 * | `ticket.replied` | `ticketmessage:<id>` | The message row is written under a unique index on its Message-ID (Phase 7), so the row is the message and the notification follows it. |
 * | `account.verify` / `account.reset` / `staff.invite` / `staff.reset` | `token:<sha-256 of the token>` | A link is one link. Better Auth mints a fresh token per request, so a genuine "send it again" is a different key and goes out — while the same request retried (a double-submitted form, a reverse proxy replaying a POST) carries the same token and sends once. The token is **hashed** into the key because `email_log` is readable by anyone with `notifications.read`, and a verification token in a log column is a login. |
 * | the document mails (`offer.document`, `invoice.document`, `creditnote.document`, `legal.change`, …) | `<document id>:<resend counter>` | An operator sending a document is a deliberate act that may legitimately be repeated — a wrong address, a bounced mail — so the counter is claimed with a conditional update on the row before the mail goes. See `resendKey` in `../outbox.ts`. |
 *
 * ## What it deliberately does *not* speak for
 *
 * Whether the *event* was handled. That is `domain_event.status`, and it is
 * set only by a dispatcher that ran to the end. One event fans out to several
 * of these, and a fan-out interrupted halfway has to be able to finish
 * without re-sending the ones that went.
 */

const money = z.number().int();

/** The two shapes every template's payload carries, as a base. */
const base = {
    /** Absolute, because a mail has no origin to resolve against. */
    siteUrl: z.string(),
    siteName: z.string(),
};

function salutation(context: TemplateContext): string {
    return context.common("salutation");
}

function regards(context: TemplateContext, operatorName: string): string {
    return `${context.common("regards")}\n${operatorName}`;
}

function define<P>(template: MailTemplate<P>): MailTemplate<P> {
    return template;
}

/* ------------------------------------------------------------------ */
/* welcome                                                            */
/* ------------------------------------------------------------------ */

const welcome = define({
    id: "welcome",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        name: z.string(),
        customerNumber: z.number().int(),
    }),
    render(payload, ctx): RenderedMail {
        return {
            subject: ctx.t("welcome.subject", { site: payload.siteName }),
            heading: ctx.t("welcome.heading", { site: payload.siteName }),
            intro: [
                ctx.t("welcome.intro1", { name: payload.name }),
                ctx.t("welcome.intro2", { site: payload.siteName }),
            ],
            action: {
                label: ctx.t("welcome.action"),
                url: `${payload.siteUrl}/client`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                {
                    label: ctx.labels("customerNumber"),
                    value: String(payload.customerNumber),
                },
            ],
            outro: [ctx.t("welcome.outro1"), ctx.t("welcome.outro2")],
        };
    },
});

/* ------------------------------------------------------------------ */
/* order confirmation                                                 */
/* ------------------------------------------------------------------ */

const orderConfirmed = define({
    id: "order.confirmed",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        orderId: z.string(),
        orderNumber: z.string(),
        grossCents: money,
        currency: z.string(),
        invoiceNumber: z.string().nullable(),
    }),
    render(payload, ctx): RenderedMail {
        const amount = formatPriceIn(
            ctx.locale,
            payload.grossCents,
            payload.currency,
        );

        return {
            subject: ctx.t("orderConfirmed.subject", {
                number: payload.orderNumber,
            }),
            heading: ctx.t("orderConfirmed.heading", {
                number: payload.orderNumber,
            }),
            intro: [
                salutation(ctx),
                ctx.t("orderConfirmed.intro2", {
                    amount,
                    number: payload.orderNumber,
                }),
                ...(payload.invoiceNumber
                    ? [
                          ctx.t("orderConfirmed.withInvoice", {
                              invoiceNumber: payload.invoiceNumber,
                          }),
                      ]
                    : []),
            ],
            action: {
                label: ctx.t("orderConfirmed.action"),
                url: `${payload.siteUrl}/client/orders/${payload.orderId}`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                {
                    label: ctx.labels("orderNumber"),
                    value: payload.orderNumber,
                },
                { label: ctx.labels("amount"), value: amount },
            ],
            outro: [
                ctx.t("orderConfirmed.outro"),
                regards(ctx, ctx.settings.operator.name),
            ],
        };
    },
});

/* ------------------------------------------------------------------ */
/* invoice notice — the automatic one                                 */
/* ------------------------------------------------------------------ */

/**
 * The notice that an invoice exists. It attaches the **stored** PDF and never
 * renders one: the bytes of a finalized document are written once and kept
 * (CLAUDE.md), so a mail about one needs no renderer — which is what lets the
 * worker send it, since `@react-pdf/renderer` cannot be imported there at all.
 *
 * Distinct from the operator's „Rechnung senden" (`invoice.document`), which
 * also carries the XRechnung XML and is a deliberate act rather than a
 * consequence of billing.
 */
const invoiceNotice = define({
    id: "invoice.notice",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        invoiceId: z.string(),
        number: z.string(),
        grossCents: money,
        currency: z.string(),
        /** ISO. Null only for an invoice issued without a due date. */
        dueAt: z.string().nullable(),
        reason: z.enum(["order", "renewal", "change", "fee", "manual"]),
        autoCharge: z.boolean().default(false),
        /** The storage key of the rendered PDF, where there is one. */
        pdfKey: z.string().nullable().default(null),
    }),
    render(payload, ctx): RenderedMail {
        const amount = formatPriceIn(
            ctx.locale,
            payload.grossCents,
            payload.currency,
        );
        const due = payload.dueAt ? new Date(payload.dueAt) : null;
        const dueAt = formatLongDateIn(ctx.locale, due);
        // `manual` reads as an ordinary invoice: an operator raising one by
        // hand is the same message to the customer as one raised by an order.
        const kind = payload.reason === "manual" ? "order" : payload.reason;
        const key = kind.charAt(0).toUpperCase() + kind.slice(1);

        return {
            subject: ctx.t(`invoiceNotice.subject${key}`, {
                number: payload.number,
            }),
            heading: ctx.t(`invoiceNotice.heading${key}`, {
                number: payload.number,
            }),
            intro: [
                salutation(ctx),
                ctx.t(`invoiceNotice.intro${key}`, {
                    number: payload.number,
                    amount,
                    dueAt,
                }),
                payload.autoCharge
                    ? ctx.t("invoiceNotice.autoCharge")
                    : ctx.t("invoiceNotice.manualCharge"),
                ...(payload.pdfKey ? [ctx.t("invoiceNotice.attached")] : []),
            ],
            action: {
                label: ctx.t("invoiceNotice.action"),
                url: `${payload.siteUrl}/client/invoices/${payload.invoiceId}`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                {
                    label: ctx.labels("invoiceNumber"),
                    value: payload.number,
                },
                { label: ctx.labels("amount"), value: amount },
                ...(due ? [{ label: ctx.labels("dueAt"), value: dueAt }] : []),
            ],
            outro: [
                ctx.common("questions"),
                regards(ctx, ctx.settings.operator.name),
            ],
        };
    },
    attachments(payload) {
        return payload.pdfKey
            ? [
                  {
                      key: payload.pdfKey,
                      filename: `${payload.number}.pdf`,
                      contentType: "application/pdf",
                  },
              ]
            : [];
    },
});

/* ------------------------------------------------------------------ */
/* payment received                                                   */
/* ------------------------------------------------------------------ */

const paymentReceived = define({
    id: "payment.received",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        purpose: z.enum(["invoice", "topup"]),
        invoiceId: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
        amountCents: money,
        currency: z.string(),
        outstandingCents: money,
        /** ISO. */
        paidAt: z.string(),
    }),
    render(payload, ctx): RenderedMail {
        const amount = formatPriceIn(
            ctx.locale,
            payload.amountCents,
            payload.currency,
        );
        const outstanding = formatPriceIn(
            ctx.locale,
            payload.outstandingCents,
            payload.currency,
        );
        const paidAt = formatLongDateIn(ctx.locale, new Date(payload.paidAt));
        const topup = payload.purpose === "topup" || !payload.invoiceNumber;
        const number = payload.invoiceNumber ?? "—";
        // A part payment must not be confirmed as "ausgeglichen": the customer
        // would reasonably stop there, and the invoice would quietly go
        // overdue. Carried over verbatim from `sendPaymentReceivedMail`.
        const settled = payload.outstandingCents <= 0;

        return {
            subject: topup
                ? ctx.t("paymentReceived.heading")
                : ctx.t("paymentReceived.subject", { number }),
            heading: ctx.t("paymentReceived.heading"),
            intro: [
                salutation(ctx),
                topup
                    ? ctx.t("paymentReceived.topup", { amount })
                    : settled
                      ? ctx.t("paymentReceived.settled", { amount, number })
                      : ctx.t("paymentReceived.partial", {
                            amount,
                            number,
                            outstanding,
                        }),
            ],
            action: topup
                ? {
                      label: ctx.t("paymentReceived.actionCredit"),
                      url: `${payload.siteUrl}/client/credit`,
                  }
                : {
                      label: ctx.t("paymentReceived.action"),
                      url: `${payload.siteUrl}/client/invoices`,
                  },
            rowsTitle: ctx.common("facts"),
            rows: [
                ...(topup
                    ? []
                    : [{ label: ctx.labels("invoiceNumber"), value: number }]),
                { label: ctx.labels("amount"), value: amount },
                { label: ctx.labels("paidAt"), value: paidAt },
                ...(topup || settled
                    ? []
                    : [
                          {
                              label: ctx.labels("outstanding"),
                              value: outstanding,
                          },
                      ]),
            ],
            outro: [regards(ctx, ctx.settings.operator.name)],
        };
    },
});

/* ------------------------------------------------------------------ */
/* payment needs the cardholder                                       */
/* ------------------------------------------------------------------ */

const paymentActionRequired = define({
    id: "payment.action_required",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        invoiceId: z.string(),
        invoiceNumber: z.string(),
        amountCents: money,
        currency: z.string(),
        url: z.string(),
    }),
    render(payload, ctx): RenderedMail {
        const amount = formatPriceIn(
            ctx.locale,
            payload.amountCents,
            payload.currency,
        );

        return {
            subject: ctx.t("paymentActionRequired.subject", {
                number: payload.invoiceNumber,
            }),
            heading: ctx.t("paymentActionRequired.heading"),
            intro: [
                salutation(ctx),
                ctx.t("paymentActionRequired.intro2", {
                    amount,
                    number: payload.invoiceNumber,
                }),
            ],
            action: {
                label: ctx.t("paymentActionRequired.action"),
                url: payload.url,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                {
                    label: ctx.labels("invoiceNumber"),
                    value: payload.invoiceNumber,
                },
                { label: ctx.labels("amount"), value: amount },
            ],
            outro: [
                ctx.t("paymentActionRequired.outro", {
                    url: `${payload.siteUrl}/client/invoices`,
                }),
                regards(ctx, ctx.settings.operator.name),
            ],
        };
    },
});

/* ------------------------------------------------------------------ */
/* payment failed                                                     */
/* ------------------------------------------------------------------ */

const paymentFailed = define({
    id: "payment.failed",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        invoiceId: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
        amountCents: money,
        currency: z.string(),
        reason: z.string().nullable(),
    }),
    render(payload, ctx): RenderedMail {
        const amount = formatPriceIn(
            ctx.locale,
            payload.amountCents,
            payload.currency,
        );
        const number = payload.invoiceNumber ?? "—";

        return {
            subject: ctx.t("paymentFailed.subject", { number }),
            heading: ctx.t("paymentFailed.heading"),
            intro: [
                salutation(ctx),
                ctx.t("paymentFailed.intro2", { amount, number }),
                /**
                 * The gateway's own words, where it gave any. A customer
                 * whose card was declined for insufficient funds can act on
                 * that; "es hat nicht geklappt" leaves them guessing — and the
                 * decline reason is not a secret, it is what their own bank
                 * told the terminal.
                 */
                ...(payload.reason
                    ? [
                          ctx.t("paymentFailed.reason", {
                              reason: payload.reason,
                          }),
                      ]
                    : []),
                ctx.t("paymentFailed.advice"),
            ],
            action: {
                label: ctx.t("paymentFailed.action"),
                url: `${payload.siteUrl}/client/payment-methods`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                ...(payload.invoiceNumber
                    ? [{ label: ctx.labels("invoiceNumber"), value: number }]
                    : []),
                { label: ctx.labels("amount"), value: amount },
            ],
            outro: [regards(ctx, ctx.settings.operator.name)],
        };
    },
});

/* ------------------------------------------------------------------ */
/* dunning — one template, the rung in the payload                    */
/* ------------------------------------------------------------------ */

/**
 * One template rather than four, because the four rungs differ in wording and
 * in nothing else — the key, the recipient, the attachment and the link are
 * identical. The rung is in the payload and the copy is picked from the
 * catalogue by it, which is also what `dunningMessage()` does; that function
 * is now the one place the wording lives, in both languages.
 */
const dunning = define({
    id: "dunning",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        level: z.enum(["reminder", "mahnung", "suspend", "terminate"]),
        invoiceId: z.string(),
        invoiceNumber: z.string(),
        outstandingCents: money,
        currency: z.string(),
        /** ISO. */
        dueAt: z.string(),
        feeCents: money.default(0),
    }),
    render(payload, ctx): RenderedMail {
        const amount = formatPriceIn(
            ctx.locale,
            payload.outstandingCents,
            payload.currency,
        );
        const fee = formatPriceIn(
            ctx.locale,
            payload.feeCents,
            payload.currency,
        );
        /**
         * The wording comes from `dunningMessage()`, which is the one place
         * that decides which of the four rungs says what — it is pure, it is
         * tested by rung in `tests/unit/dunning.test.ts`, and it reads the
         * same catalogue this template does. Repeating the branch here would
         * be a second answer to "what does a Mahnung say".
         */
        const message = dunningMessage({
            level: payload.level,
            invoiceNumber: payload.invoiceNumber,
            formatted: amount,
            dueAt: new Date(payload.dueAt),
            locale: ctx.locale,
        });

        return {
            subject: message.subject,
            heading: message.subject,
            intro: [
                ...message.lines,
                ...(payload.feeCents > 0
                    ? [ctx.t("dunning.feeNotice", { fee })]
                    : []),
            ],
            action: {
                label: ctx.t("dunning.action"),
                url: `${payload.siteUrl}/client/invoices/${payload.invoiceId}`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                {
                    label: ctx.labels("invoice"),
                    value: payload.invoiceNumber,
                },
                { label: ctx.labels("amount"), value: amount },
                ...(payload.feeCents > 0
                    ? [{ label: ctx.labels("dunningFee"), value: fee }]
                    : []),
            ],
            outro: [],
        };
    },
});

/* ------------------------------------------------------------------ */
/* trial ending                                                       */
/* ------------------------------------------------------------------ */

const trialEnding = define({
    id: "subscription.trial_ending",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        subscriptionId: z.string(),
        label: z.string(),
        amountCents: money,
        currency: z.string(),
        /** ISO. */
        chargeAt: z.string(),
    }),
    render(payload, ctx): RenderedMail {
        const amount = formatPriceIn(
            ctx.locale,
            payload.amountCents,
            payload.currency,
        );
        const day = formatLongDateIn(ctx.locale, new Date(payload.chargeAt));

        return {
            subject: ctx.t("trialEnding.subject", { day }),
            heading: ctx.t("trialEnding.heading"),
            intro: [
                ctx.t("trialEnding.intro1", { label: payload.label, day }),
                ctx.t("trialEnding.intro2", { amount }),
            ],
            action: {
                label: ctx.t("trialEnding.action"),
                url: `${payload.siteUrl}/client/subscriptions/${payload.subscriptionId}`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                { label: ctx.labels("subscription"), value: payload.label },
                { label: ctx.labels("trialEnd"), value: day },
                { label: ctx.labels("afterwards"), value: amount },
            ],
            outro: [],
        };
    },
});

/* ------------------------------------------------------------------ */
/* subscription ended                                                 */
/* ------------------------------------------------------------------ */

const subscriptionEnded = define({
    id: "subscription.ended",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        subscriptionId: z.string(),
        label: z.string(),
        /** ISO. */
        endedAt: z.string(),
    }),
    render(payload, ctx): RenderedMail {
        const day = formatLongDateIn(ctx.locale, new Date(payload.endedAt));

        return {
            subject: ctx.t("subscriptionEnded.subject", {
                label: payload.label,
            }),
            heading: ctx.t("subscriptionEnded.heading"),
            intro: [
                salutation(ctx),
                ctx.t("subscriptionEnded.intro2", {
                    label: payload.label,
                    day,
                }),
            ],
            action: {
                label: ctx.t("subscriptionEnded.action"),
                url: `${payload.siteUrl}/client/subscriptions/${payload.subscriptionId}`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                { label: ctx.labels("subscription"), value: payload.label },
                { label: ctx.labels("period"), value: day },
            ],
            outro: [
                ctx.t("subscriptionEnded.outro"),
                regards(ctx, ctx.settings.operator.name),
            ],
        };
    },
});

/* ------------------------------------------------------------------ */
/* services                                                           */
/* ------------------------------------------------------------------ */

const serviceActivated = define({
    id: "service.activated",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        serviceId: z.string(),
        label: z.string(),
        hostname: z.string().nullable(),
    }),
    render(payload, ctx): RenderedMail {
        return {
            subject: ctx.t("serviceActivated.subject", {
                label: payload.label,
            }),
            heading: ctx.t("serviceActivated.heading"),
            intro: [
                salutation(ctx),
                ctx.t("serviceActivated.intro2", { label: payload.label }),
            ],
            action: {
                label: ctx.t("serviceActivated.action"),
                url: `${payload.siteUrl}/client/services/${payload.serviceId}`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                { label: ctx.labels("service"), value: payload.label },
                ...(payload.hostname
                    ? [
                          {
                              label: ctx.labels("hostname"),
                              value: payload.hostname,
                          },
                      ]
                    : []),
            ],
            /**
             * The build plan says it in the same breath as the link: **no
             * plaintext passwords**. A mail is stored unencrypted on at least
             * two servers and forwarded by habit; the portal reveals the
             * credential behind a session and audits the reveal (Phase 8).
             */
            outro: [
                ctx.t("serviceActivated.outro"),
                regards(ctx, ctx.settings.operator.name),
            ],
        };
    },
});

function serviceStateTemplate(
    id: "service.suspended" | "service.terminated",
    namespace: "serviceSuspended" | "serviceTerminated",
    href: (payload: { siteUrl: string; serviceId: string }) => string,
) {
    return define({
        id,
        delivery: "outbox" as const,
        resendable: true,
        payload: z.object({
            ...base,
            serviceId: z.string(),
            label: z.string(),
            reason: z.enum(["dunning", "subscription", "manual"]),
        }),
        render(payload, ctx): RenderedMail {
            const which =
                payload.reason === "dunning"
                    ? "introDunning"
                    : payload.reason === "subscription"
                      ? "introSubscription"
                      : "introManual";

            return {
                subject: ctx.t(`${namespace}.subject`, {
                    label: payload.label,
                }),
                heading: ctx.t(`${namespace}.heading`),
                intro: [
                    salutation(ctx),
                    ctx.t(`${namespace}.${which}`, { label: payload.label }),
                ],
                action: {
                    label: ctx.t(`${namespace}.action`),
                    url: href(payload),
                },
                rowsTitle: ctx.common("facts"),
                rows: [{ label: ctx.labels("service"), value: payload.label }],
                outro: [
                    ctx.t(`${namespace}.outro`),
                    regards(ctx, ctx.settings.operator.name),
                ],
            };
        },
    });
}

const serviceSuspended = serviceStateTemplate(
    "service.suspended",
    "serviceSuspended",
    (payload) => `${payload.siteUrl}/client/invoices`,
);

const serviceTerminated = serviceStateTemplate(
    "service.terminated",
    "serviceTerminated",
    (payload) => `${payload.siteUrl}/client`,
);

/* ------------------------------------------------------------------ */
/* ticket reply                                                       */
/* ------------------------------------------------------------------ */

/**
 * **A notification, not the reply.**
 *
 * The reply itself goes out through the ticket channel — Graph, from the
 * department's shared mailbox, in the original thread — and that is Phase 7's
 * `sendTicketReply`. This is the message for the case where the reply could
 * not be mailed to the person at all: a ticket opened in the portal by a
 * contact whose address the thread does not carry. It says that there is an
 * answer and where to read it, and it quotes nothing, because quoting a
 * support conversation into a second mail is how it reaches an address the
 * ticket never agreed to.
 */
const ticketReplied = define({
    id: "ticket.replied",
    delivery: "outbox",
    resendable: true,
    payload: z.object({
        ...base,
        ticketId: z.string(),
        number: z.number().int(),
        ticketSubject: z.string(),
    }),
    render(payload, ctx): RenderedMail {
        return {
            subject: ctx.t("ticketReplied.subject", {
                number: payload.number,
                subject: payload.ticketSubject,
            }),
            heading: ctx.t("ticketReplied.heading", { number: payload.number }),
            intro: [
                salutation(ctx),
                ctx.t("ticketReplied.intro2", {
                    subject: payload.ticketSubject,
                }),
            ],
            action: {
                label: ctx.t("ticketReplied.action"),
                url: `${payload.siteUrl}/client/tickets/${payload.ticketId}`,
            },
            rowsTitle: ctx.common("facts"),
            rows: [
                {
                    label: ctx.labels("ticket"),
                    value: `#${payload.number}`,
                },
                {
                    label: ctx.labels("subject"),
                    value: payload.ticketSubject,
                },
            ],
            outro: [regards(ctx, ctx.settings.operator.name)],
        };
    },
});

/* ------------------------------------------------------------------ */

/**
 * The catalogue. The keys are written out as literals rather than taken from
 * each entry's `id`: a computed key widens to `string`, and with it
 * `MailTemplateId` — which is what makes `MAIL_TEMPLATE_LABELS` below an
 * exhaustive map instead of an optional one, and what lets a caller say
 * `mailTemplate("invoice.notice")` and be checked.
 *
 * The `satisfies` keeps the two in step: an entry filed under the wrong key is
 * a type error, because `id` is part of the value.
 */
export const MAIL_TEMPLATES = {
    welcome,
    "order.confirmed": orderConfirmed,
    "invoice.notice": invoiceNotice,
    "payment.received": paymentReceived,
    "payment.action_required": paymentActionRequired,
    "payment.failed": paymentFailed,
    dunning,
    "subscription.trial_ending": trialEnding,
    "subscription.ended": subscriptionEnded,
    "service.activated": serviceActivated,
    "service.suspended": serviceSuspended,
    "service.terminated": serviceTerminated,
    "ticket.replied": ticketReplied,
} as const satisfies Record<string, AnyMailTemplate>;

export type MailTemplateId = keyof typeof MAIL_TEMPLATES;

export const MAIL_TEMPLATE_IDS = Object.keys(
    MAIL_TEMPLATES,
) as MailTemplateId[];

export function isMailTemplateId(value: unknown): value is MailTemplateId {
    return typeof value === "string" && value in MAIL_TEMPLATES;
}

export function mailTemplate(id: string): AnyMailTemplate | null {
    return isMailTemplateId(id) ? MAIL_TEMPLATES[id] : null;
}

/** German labels for the admin list, which is German (rule 13). */
export const MAIL_TEMPLATE_LABELS: Record<MailTemplateId, string> = {
    welcome: "Willkommen",
    "order.confirmed": "Bestellbestätigung",
    "invoice.notice": "Rechnung gestellt",
    "payment.received": "Zahlungseingang",
    "payment.action_required": "Bestätigung erforderlich",
    "payment.failed": "Zahlung fehlgeschlagen",
    dunning: "Mahnwesen",
    "subscription.trial_ending": "Testphase endet",
    "subscription.ended": "Abo beendet",
    "service.activated": "Leistung eingerichtet",
    "service.suspended": "Leistung gesperrt",
    "service.terminated": "Leistung abgebaut",
    "ticket.replied": "Antwort im Ticket",
};

export type { RenderedMail } from "./types";
