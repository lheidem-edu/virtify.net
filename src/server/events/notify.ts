import { eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { MailRequest } from "@/server/mail/outbox";
import type { Settings } from "@/server/settings";
import type { DomainEventOf, EventType } from "./catalog";
import { type Audience, invoiceRecipient, recipientsFor } from "./recipients";

/**
 * What a fact means for somebody's inbox.
 *
 * ## The bus may notify. It may not decide.
 *
 * Every function here is handed a handle that can only `select` and
 * **returns** the mail it wants. It has nothing to settle a payment with, no
 * way to move a subscription and no way to reach a machine — so the one
 * failure mode an event bus is famous for, a listener that quietly becomes a
 * second `applyPayment`, is a type error here rather than a code review.
 *
 * If a notifier ever genuinely needs to change something, that is a sign the
 * *emitter* is in the wrong place: the fact it is reacting to should have
 * been made true in the transaction that emitted the event.
 *
 * ## One event, several mails
 *
 * A fan-out is a list, and each entry carries its own `dedupeKey` into
 * `email_log` — keyed on the cause *and the address*, so an interrupted
 * fan-out finishes without re-sending the part that went. See the key table
 * in `src/server/mail/templates/index.ts`.
 */

type Reader = Pick<typeof defaultDb, "select">;

export type NotifyContext = {
    db: Reader;
    settings: Settings;
};

type Notifier<T extends EventType> = (
    event: DomainEventOf<T>,
    context: NotifyContext,
) => Promise<MailRequest[]>;

/** The two fields every template's payload carries. */
function site(settings: Settings) {
    return { siteUrl: settings.site.url, siteName: settings.site.name };
}

/**
 * Builds one request per contact who should hear about this.
 *
 * The key is the caller's cause with the address appended by the unique
 * index rather than by the string — `(template, to_email, dedupe_key)` — so
 * two contacts on one account are two rows under the same cause and neither
 * suppresses the other.
 */
async function fanOut(
    context: NotifyContext,
    input: {
        customerId: string | null;
        audience: Audience;
        template: string;
        dedupeKey: string;
        entityType: string;
        entityId: string;
        eventId: string;
        payload: Record<string, unknown>;
    },
): Promise<MailRequest[]> {
    if (!input.customerId) {
        return [];
    }

    const recipients = await recipientsFor(
        context.db,
        input.customerId,
        input.audience,
    );

    return recipients.map((recipient) => ({
        template: input.template,
        dedupeKey: input.dedupeKey,
        toEmail: recipient.email,
        toName: recipient.name,
        locale: recipient.locale,
        customerId: input.customerId,
        eventId: input.eventId,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload,
    }));
}

const notifiers: {
    [T in EventType]?: Notifier<T>;
} = {
    "customer.registered": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "any",
            template: "welcome",
            dedupeKey: `customer:${event.entityId}`,
            entityType: "customer",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                name: event.payload.name,
                customerNumber: event.payload.customerNumber,
            },
        });
    },

    "order.placed": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "order.confirmed",
            dedupeKey: `order:${event.entityId}`,
            entityType: "order",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                orderId: event.entityId,
                orderNumber: event.payload.orderNumber,
                grossCents: event.payload.grossCents,
                currency: event.payload.currency,
                invoiceNumber: event.payload.invoiceNumber,
            },
        });
    },

    "invoice.issued": async (event, context) => {
        /**
         * The PDF's storage key, read now rather than stored in the event:
         * the invoice is finalized inside the emitting transaction and the
         * bytes are written a moment later, outside it, so the event cannot
         * know the key yet. A mail whose document is not there is deferred
         * rather than sent without it (see `resolveAttachments`).
         */
        const [row] = await context.db
            .select({
                pdfKey: schema.invoice.pdfKey,
                autoCharge: schema.subscription.autoCharge,
            })
            .from(schema.invoice)
            .leftJoin(
                schema.subscriptionInvoice,
                eq(schema.subscriptionInvoice.invoiceId, schema.invoice.id),
            )
            .leftJoin(
                schema.subscription,
                eq(
                    schema.subscription.id,
                    schema.subscriptionInvoice.subscriptionId,
                ),
            )
            .where(eq(schema.invoice.id, event.entityId))
            .limit(1);

        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "invoice.notice",
            dedupeKey: `invoice:${event.entityId}`,
            entityType: "invoice",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                invoiceId: event.entityId,
                number: event.payload.number,
                grossCents: event.payload.grossCents,
                currency: event.payload.currency,
                dueAt: event.payload.dueAt,
                reason: event.payload.reason,
                autoCharge: row?.autoCharge ?? false,
                pdfKey: row?.pdfKey ?? null,
            },
        });
    },

    "payment.received": async (event, context) => {
        /**
         * **No receipt for a payment against a corrected document.** The money
         * is recorded and it becomes credit, but what a payment against a
         * cancelled invoice *means* is a decision the operator makes (AGB
         * § 8) — a mail saying "die Rechnung ist damit ausgeglichen" about a
         * document that was taken back would be wrong in both directions.
         * Carried over from `settleAgainstInvoice`, which has always
         * suppressed the receipt in this case.
         */
        if (event.payload.invoiceStatus === "cancelled") {
            return [];
        }

        const payload = {
            ...site(context.settings),
            purpose: event.payload.purpose,
            invoiceId: event.payload.invoiceId,
            invoiceNumber: event.payload.invoiceNumber,
            amountCents: event.payload.amountCents,
            currency: event.payload.currency,
            outstandingCents: event.payload.outstandingCents,
            paidAt: event.occurredAt.toISOString(),
        };

        /**
         * The address the invoice itself names, where it names one: a receipt
         * follows the *document* rather than a since-changed contact list. It
         * is the same rule as rule 3 in a different costume — a finalized
         * invoice does not change, including in who it was for.
         */
        if (event.payload.invoiceId) {
            const frozen = await invoiceRecipient(
                context.db,
                event.payload.invoiceId,
            );

            if (frozen) {
                return [
                    {
                        template: "payment.received",
                        dedupeKey: `payment:${event.entityId}`,
                        toEmail: frozen.email,
                        toName: frozen.name,
                        locale: frozen.locale,
                        customerId: event.customerId,
                        eventId: event.id,
                        entityType: "payment",
                        entityId: event.entityId,
                        payload,
                    },
                ];
            }
        }

        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "payment.received",
            dedupeKey: `payment:${event.entityId}`,
            entityType: "payment",
            entityId: event.entityId,
            eventId: event.id,
            payload,
        });
    },

    "payment.action_required": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "payment.action_required",
            dedupeKey: `payment:${event.entityId}`,
            entityType: "payment",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                invoiceId: event.payload.invoiceId,
                invoiceNumber: event.payload.invoiceNumber,
                amountCents: event.payload.amountCents,
                currency: event.payload.currency,
                url: event.payload.url,
            },
        });
    },

    "payment.failed": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "payment.failed",
            dedupeKey: `payment:${event.entityId}`,
            entityType: "payment",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                invoiceId: event.payload.invoiceId,
                invoiceNumber: event.payload.invoiceNumber,
                amountCents: event.payload.amountCents,
                currency: event.payload.currency,
                reason: event.payload.reason,
            },
        });
    },

    "dunning.reached": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "dunning",
            // The rung, which `dunning_action (invoice_id, level)` already
            // claimed. Its row id *is* one rung, once.
            dedupeKey: `dunning:${event.entityId}`,
            entityType: "dunning_action",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                level: event.payload.level,
                invoiceId: event.payload.invoiceId,
                invoiceNumber: event.payload.invoiceNumber,
                outstandingCents: event.payload.outstandingCents,
                currency: event.payload.currency,
                dueAt: event.payload.dueAt,
                feeCents: event.payload.feeCents,
            },
        });
    },

    "subscription.trial_ending": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "subscription.trial_ending",
            // The end date is in the key: a trial moved by a plan change is a
            // different notice, and the subscription id alone would silence
            // the second one for ever.
            dedupeKey: `subscription:${event.entityId}:trial:${event.payload.chargeAt}`,
            entityType: "subscription",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                subscriptionId: event.entityId,
                label: event.payload.label,
                amountCents: event.payload.amountCents,
                currency: event.payload.currency,
                chargeAt: event.payload.chargeAt,
            },
        });
    },

    "subscription.ended": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "subscription.ended",
            dedupeKey: `subscription:${event.entityId}:${event.dedupeKey}`,
            entityType: "subscription",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                subscriptionId: event.entityId,
                label: event.payload.label,
                endedAt: event.payload.endedAt,
            },
        });
    },

    "service.activated": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "technical",
            template: "service.activated",
            dedupeKey: `service:${event.entityId}:${event.dedupeKey}`,
            entityType: "service",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                serviceId: event.entityId,
                label: event.payload.label,
                hostname: event.payload.hostname,
            },
        });
    },

    "service.suspended": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            /**
             * Billing, not technical: a suspension is almost always about
             * money, and the person who can do something about it is the one
             * who gets the invoices. The technical contact learns it from
             * the portal, where the service says so.
             */
            audience: "billing",
            template: "service.suspended",
            dedupeKey: `service:${event.entityId}:${event.dedupeKey}`,
            entityType: "service",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                serviceId: event.entityId,
                label: event.payload.label,
                reason: event.payload.reason,
            },
        });
    },

    "service.terminated": async (event, context) => {
        return fanOut(context, {
            customerId: event.customerId,
            audience: "billing",
            template: "service.terminated",
            dedupeKey: `service:${event.entityId}:${event.dedupeKey}`,
            entityType: "service",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                serviceId: event.entityId,
                label: event.payload.label,
                reason: event.payload.reason,
            },
        });
    },

    "ticket.replied": async (event, context) => {
        /**
         * **Only a staff reply, and only to the people the ticket already
         * knows about.** The reply itself goes out through the ticket channel
         * in the original thread (Phase 7); this is the portal notification
         * beside it, and the audience is `tickets` rather than the sender of
         * the last message — a ticket number travels on a subject line and
         * the numbers are sequential, so answering whoever wrote last turns a
         * guessed number into somebody else's support history.
         */
        if (event.payload.author !== "staff") {
            return [];
        }

        const requests = await fanOut(context, {
            customerId: event.customerId,
            audience: "tickets",
            template: "ticket.replied",
            dedupeKey: `ticketmessage:${event.entityId}`,
            entityType: "ticket_message",
            entityId: event.entityId,
            eventId: event.id,
            payload: {
                ...site(context.settings),
                ticketId: event.payload.ticketId,
                number: event.payload.number,
                ticketSubject: event.payload.subject,
            },
        });

        /**
         * Everyone the reply already reached is dropped. The reply carries
         * the answer; this carries only a link to it, and a customer who got
         * both would read the second as a second answer.
         */
        const reached = new Set(
            event.payload.notifiedEmails.map((entry) =>
                entry.trim().toLowerCase(),
            ),
        );

        return requests.filter(
            (request) => !reached.has(request.toEmail.trim().toLowerCase()),
        );
    },
};

/**
 * Every mail one event asks for.
 *
 * An event with no notifier produces nothing and that is a valid answer, not
 * an error: `invoice.paid`, `subscription.cancelled` and `ticket.created`
 * exist for Phase 10's webhooks and for the portal's activity list, and the
 * customer already hears about each of them another way — the receipt, the
 * cancellation confirmation, the ticket acknowledgement.
 */
export async function notificationsFor(
    event: DomainEventOf,
    context: NotifyContext,
): Promise<MailRequest[]> {
    const notifier = notifiers[event.type] as Notifier<EventType> | undefined;

    if (!notifier) {
        return [];
    }

    return notifier(event, context);
}

/** Which event types produce mail. Used by the admin page and by a test. */
export const NOTIFIED_EVENT_TYPES = Object.keys(notifiers) as EventType[];
