import { z } from "zod";

/**
 * What can happen, and what each occurrence is keyed on.
 *
 * Deliberately framework-free and database-free: this module is imported by
 * the emitters (which run inside transactions), by the dispatcher, by the
 * notifiers and by the tests, and a payload schema that needed a connection
 * could not be checked in any of them.
 *
 * ## The event bus may notify. It may not decide.
 *
 * `applyPayment()` is the only place money meets a document,
 * `transitionSubscriptionIn()` the only status change,
 * `processInboundMessage()` the only way mail becomes a ticket message and
 * `runProvisioningTask()` the only call to a machine. An event bus is exactly
 * the shape that grows a second one of those — a listener that settles,
 * transitions or provisions is a second answer to a question that already has
 * one, and the one that is wrong is the one somebody finds.
 *
 * So the rule is structural rather than written down: a subscriber is handed
 * a database handle that can only `select` and it **returns** the mail it
 * wants. It cannot insert, update or delete, because it has nothing to do it
 * with. See `./notify.ts`.
 *
 * ## What each key speaks for
 *
 * The key is derived from the row that *is* the occurrence, never from the
 * clock and never from a counter read a moment earlier.
 *
 * | event | key | what makes it right |
 * |---|---|---|
 * | `customer.registered` | the customer id | An account is opened once, for ever. |
 * | `order.placed` | the order id | `placeOrder()` writes the order in one transaction; its id is the order. |
 * | `invoice.issued` | the invoice id | An invoice is finalized once and never again (rule 3), so its number existing *is* the occurrence. |
 * | `invoice.paid` | the invoice id | It reaches `paid` once: `settleAgainstInvoice` writes the status inside the transaction that holds the row, and a second settlement finds it already there. A *part* payment is `payment.received`, not this. |
 * | `payment.received` | the payment id | One payment, one receipt. A webhook delivered twice settles once (rule 7) and so emits once. |
 * | `payment.action_required` | the payment id | The attempt is recorded under a reference we generated before the gateway was called, so the id is the attempt and a retried collection is a new one. |
 * | `payment.failed` | the payment id | The same. |
 * | `subscription.renewed` | the renewal invoice's id | The period is claimed under `subscription_invoice (subscription_id, period_start, kind)`; the invoice that claim produced names it once. The subscription id alone would be every renewal it ever has. |
 * | `subscription.trial_ending` | `<subscription id>:<trial end, ISO>` | The same end seen on two passes is one notice; an end moved by a plan change is a different one, and the customer has to be told again. |
 * | `subscription.cancelled` / `.ended` / `.paused` / `.resumed` | the subscription event id | `transitionSubscriptionIn` mints it inside the transaction that writes the status. Unique per occurrence, so an Abo cancelled, resumed and cancelled again is two cancellations — while the same transition reached twice in one transaction is one. |
 * | `dunning.reached` | the `dunning_action` row id | The rung is already claimed under `dunning_action (invoice_id, level)`, so that row *is* one rung, once. The invoice plus the level would be the same thing spelled out twice. |
 * | `service.activated` / `.suspended` / `.terminated` | `<service id>:<cause>` | The cause is the status change `applyServiceFollow` was given — the subscription event, the dunning action. The service id is in it because one cause moves several services and each gets its own line. |
 * | `ticket.created` | the ticket id | A ticket is opened once. |
 * | `ticket.replied` | the ticket message id | `processInboundMessage` and the staff reply both write the message under a unique index; the row is the message. |
 *
 * ## What the key deliberately does *not* speak for
 *
 * Whether anybody has been told. One event fans out to several mails, and a
 * fan-out interrupted halfway has to be able to finish without re-sending
 * the ones that went — so each mail carries its own key into `email_log`.
 */

const money = z.number().int();

/**
 * Payload schemas. Every one of them is *snapshot data*: what was true when
 * the fact happened. A subscriber that looked a figure up again would be
 * reporting today's answer about yesterday's event.
 */
export const EVENT_PAYLOADS = {
    "customer.registered": z.object({
        customerNumber: z.number().int(),
        name: z.string(),
        email: z.string(),
    }),

    "order.placed": z.object({
        orderNumber: z.string(),
        grossCents: money,
        currency: z.string(),
        invoiceId: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
    }),

    "invoice.issued": z.object({
        number: z.string(),
        grossCents: money,
        currency: z.string(),
        dueAt: z.string().nullable(),
        /** `renewal` sends a different message from a first invoice. */
        reason: z.enum(["order", "renewal", "change", "fee", "manual"]),
    }),

    "invoice.paid": z.object({
        number: z.string(),
        grossCents: money,
        currency: z.string(),
        paidAt: z.string(),
    }),

    "payment.received": z.object({
        amountCents: money,
        currency: z.string(),
        provider: z.string(),
        purpose: z.enum(["invoice", "topup"]),
        invoiceId: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
        /** What is still owed on the document afterwards. */
        outstandingCents: money,
        /**
         * The document's status after the money was booked, or null for a
         * top-up. `cancelled` is why it is here: a payment against a document
         * that has been corrected away is still recorded and still becomes
         * credit, but what it *means* is a decision the operator makes (AGB
         * § 8), so no receipt goes out claiming it settled anything.
         */
        invoiceStatus: z.string().nullable(),
    }),

    "payment.action_required": z.object({
        amountCents: money,
        currency: z.string(),
        invoiceId: z.string(),
        invoiceNumber: z.string(),
        /** Where the customer finishes the authentication. */
        url: z.string(),
    }),

    "payment.failed": z.object({
        amountCents: money,
        currency: z.string(),
        invoiceId: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
        reason: z.string().nullable(),
    }),

    "subscription.renewed": z.object({
        subscriptionId: z.string(),
        invoiceNumber: z.string(),
        grossCents: money,
        currency: z.string(),
        dueAt: z.string(),
        periodStart: z.string(),
        periodEnd: z.string().nullable(),
        autoCharge: z.boolean(),
    }),

    "subscription.trial_ending": z.object({
        label: z.string(),
        amountCents: money,
        currency: z.string(),
        chargeAt: z.string(),
    }),

    "subscription.cancelled": z.object({
        label: z.string(),
        /** When it stops running, which is the end of the paid period. */
        endsAt: z.string().nullable(),
        atPeriodEnd: z.boolean(),
    }),

    "subscription.ended": z.object({
        label: z.string(),
        endedAt: z.string(),
    }),

    "dunning.reached": z.object({
        level: z.enum(["reminder", "mahnung", "suspend", "terminate"]),
        invoiceId: z.string(),
        invoiceNumber: z.string(),
        outstandingCents: money,
        currency: z.string(),
        dueAt: z.string(),
        feeCents: money,
    }),

    "service.activated": z.object({
        serviceId: z.string(),
        label: z.string(),
        hostname: z.string().nullable(),
    }),

    "service.suspended": z.object({
        serviceId: z.string(),
        label: z.string(),
        /** `dunning` or `subscription`, so the mail can say why. */
        reason: z.enum(["dunning", "subscription", "manual"]),
    }),

    "service.terminated": z.object({
        serviceId: z.string(),
        label: z.string(),
        reason: z.enum(["dunning", "subscription", "manual"]),
    }),

    "ticket.created": z.object({
        ticketId: z.string(),
        number: z.number().int(),
        subject: z.string(),
        /** `portal` or `mail` — a mail-in is acknowledged by Phase 7. */
        origin: z.enum(["portal", "mail", "staff"]),
    }),

    "ticket.replied": z.object({
        ticketId: z.string(),
        number: z.number().int(),
        subject: z.string(),
        /** Who wrote it. Only a staff reply is notified to the customer. */
        author: z.enum(["staff", "customer", "system"]),
        /**
         * The addresses the reply itself was mailed to, lower-cased.
         *
         * A staff reply **is** a mail: it goes out through the department's
         * shared mailbox, in the original thread, with the quoted history
         * (Phase 7). So the portal notification exists only for the people
         * that mail did not reach — a contact who holds `can_tickets` but
         * whose address the thread does not carry. Sending it to everyone
         * would be two mails about one answer, one of them without the
         * answer in it.
         */
        notifiedEmails: z.array(z.string()).default([]),
    }),
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;

export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];

export type EventPayload<T extends EventType> = z.infer<
    (typeof EVENT_PAYLOADS)[T]
>;

/** A written event, as a subscriber sees it. */
export type DomainEventOf<T extends EventType = EventType> = {
    id: string;
    type: T;
    dedupeKey: string;
    occurredAt: Date;
    customerId: string | null;
    entityType: string;
    entityId: string;
    payload: EventPayload<T>;
};

export function isEventType(value: unknown): value is EventType {
    return typeof value === "string" && value in EVENT_PAYLOADS;
}

/**
 * Checks a payload against its type's schema.
 *
 * Called on the way *in*, so a malformed payload is the emitter's error and
 * not a dispatcher that silently sends a mail with `undefined` in it. zod at
 * every boundary (CLAUDE.md), and the transaction boundary is one.
 */
export function parseEventPayload<T extends EventType>(
    type: T,
    payload: unknown,
): EventPayload<T> {
    return EVENT_PAYLOADS[type].parse(payload) as EventPayload<T>;
}

/**
 * German labels for the admin list. The events themselves are English
 * identifiers (rule 13: code is English, the product is German).
 */
export const EVENT_LABELS: Record<EventType, string> = {
    "customer.registered": "Konto angelegt",
    "order.placed": "Bestellung aufgegeben",
    "invoice.issued": "Rechnung gestellt",
    "invoice.paid": "Rechnung bezahlt",
    "payment.received": "Zahlung eingegangen",
    "payment.action_required": "Zahlung: Bestätigung erforderlich",
    "payment.failed": "Zahlung fehlgeschlagen",
    "subscription.renewed": "Abo verlängert",
    "subscription.trial_ending": "Testphase endet",
    "subscription.cancelled": "Abo gekündigt",
    "subscription.ended": "Abo beendet",
    "dunning.reached": "Mahnstufe erreicht",
    "service.activated": "Leistung aktiv",
    "service.suspended": "Leistung gesperrt",
    "service.terminated": "Leistung abgebaut",
    "ticket.created": "Ticket angelegt",
    "ticket.replied": "Antwort im Ticket",
};
