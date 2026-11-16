import {
    index,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";
import { customer } from "./customers";

/**
 * The internal event bus, and the outbox every notification leaves through.
 *
 * Phase 9's two tables. They are two and not one because they answer two
 * different questions:
 *
 *  - `domain_event` says **what happened**. It is written inside the
 *    transaction that made the fact true, so an event that exists describes
 *    something that committed, and a fact that committed has its event.
 *  - `email_log` says **which mail should exist**. One event can produce
 *    several — to the billing contact and the technical contact, in two
 *    languages — and a mail can exist without an event at all (a password
 *    reset is not a domain fact, it is a request).
 *
 * Phase 10 hangs outbound webhooks off the same `domain_event` rows with a
 * delivery table of its own, which is why the event carries a payload rather
 * than only the ids: a webhook subscriber cannot read the database.
 */

export const domainEventStatus = pgEnum("domain_event_status", [
    /** Written, not yet turned into notifications. */
    "pending",
    /** A dispatcher ran to the end. */
    "dispatched",
    /** It kept failing. A person has to look; nothing retries it. */
    "abandoned",
]);

/**
 * One thing that happened, once.
 *
 * ## What `(type, dedupe_key)` speaks for
 *
 * **One occurrence of one fact.** Not one attempt, not one job, not one pass
 * of a sweep. The emitter says which occurrence it is, and the key is
 * derived from the row that *is* that occurrence — the payment, the dunning
 * action, the invoice — never from the clock and never from a counter read a
 * moment earlier. `emitEvent` inserts with `on conflict do nothing`, so the
 * same fact emitted from two places is one row and the second emitter adds
 * nothing.
 *
 * The keys are written out in `src/server/events/catalog.ts`, in a table,
 * because Phase 6 shipped a day-scoped claim taken by a customer-scoped pass
 * and Phase 7 shipped a per-mailbox claim behind an installation-wide unique
 * index, and both times the defect was this question answered carelessly.
 *
 * ## What it deliberately does *not* speak for
 *
 * Whether anybody has been told. That is `email_log`, keyed on its own cause,
 * because one event fans out to several mails and a partial fan-out must be
 * able to finish without re-sending the ones that already went.
 */
export const domainEvent = pgTable(
    "domain_event",
    {
        id: ulidPk("event"),

        /** `invoice.paid`, `subscription.renewed`, … — see the catalogue. */
        type: text("type").notNull(),

        /**
         * What this occurrence is, in the emitter's own terms. See the header.
         */
        dedupeKey: text("dedupe_key").notNull(),

        /**
         * When the fact became true, which is not when the row was written: a
         * billing pass dated to yesterday emits events dated to yesterday.
         */
        occurredAt: timestamp("occurred_at").notNull().defaultNow(),

        /**
         * Whose event it is. Null for the ones that belong to nobody — a
         * threshold warning is the operator's. Never used for authorisation:
         * a notification is scoped by the recipient address it resolves to,
         * and the portal never reads this table at all.
         */
        customerId: ulidFk("customer_id").references(() => customer.id, {
            onDelete: "set null",
        }),

        /** `invoice`, `subscription`, `service`, `ticket`, … and its id. */
        entityType: text("entity_type").notNull(),
        entityId: text("entity_id").notNull(),

        /**
         * Everything a subscriber needs that it cannot look up — amounts as
         * they were, the status it moved from, the document number. A later
         * reader must not have to re-derive a figure that has since changed.
         */
        payload: jsonb("payload").notNull().default({}),

        status: domainEventStatus("status").notNull().default("pending"),
        /** Set only by a dispatcher that ran to the end. */
        dispatchedAt: timestamp("dispatched_at"),
        attempts: integer("attempts").notNull().default(0),
        maxAttempts: integer("max_attempts").notNull().default(5),
        /** Not before this. The backoff after a failed dispatch. */
        runAfter: timestamp("run_after"),
        lastError: text("last_error"),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("domain_event_dedupe_idx").on(table.type, table.dedupeKey),
        /** The sweep's query: what is still to do, oldest first. */
        index("domain_event_pending_idx").on(table.status, table.runAfter),
        index("domain_event_customer_id_idx").on(table.customerId),
        index("domain_event_type_idx").on(table.type),
    ],
);

export const emailStatus = pgEnum("email_status", [
    /** Queued. Runnable. */
    "pending",
    /** Somebody's claim. **Does not go back to `pending` on its own.** */
    "sending",
    "sent",
    /**
     * The send itself failed and there are attempts left. Runnable, with a
     * backoff — see `provisioning_task`'s header for why a terminal failure
     * still gets one.
     */
    "failed",
    /**
     * **We cannot tell whether it went out.** The send returned and the
     * recording of it did not, or a claim expired while a send was in
     * flight. It is never retried automatically: the customer may be holding
     * that mail, and a retry would be the second copy. An operator decides,
     * and their decision is a new row.
     */
    "unknown",
    /** Given up on: no attempts left, or the operator cancelled it. */
    "abandoned",
]);

/**
 * One mail that should exist.
 *
 * ## What `(template, to_email, dedupe_key)` speaks for
 *
 * **One message to one address about one cause.** The address is in the key
 * because an event fans out — the invoice notice goes to the billing contact
 * and, where the account has one, to a second address — and those are two
 * mails, not one sent twice. The template is in the key because one cause
 * produces different messages: a suspension both tells the customer and
 * warns the operator.
 *
 * Every template's key is written out in `src/server/mail/templates`, in a
 * table, next to what makes it right.
 *
 * ## Why a resend is a new row
 *
 * A row with `sent_at` is the record of a mail that left the building, and
 * rewriting it loses that. „Erneut senden" therefore claims the next resend
 * number with a conditional update on the original row and inserts a *new*
 * row keyed `resend:<original id>:<n>` — so a double-clicked button sends
 * one mail (the second click carries a stale number and loses), and two
 * deliberate resends a week apart are two rows with two records.
 */
export const emailLog = pgTable(
    "email_log",
    {
        id: ulidPk("email"),

        /** Which message this is — the key into the template catalogue. */
        template: text("template").notNull(),
        /** `de` or `en`, resolved from the customer when it was queued. */
        locale: text("locale").notNull().default("de"),

        /** What this mail is for. See the header. */
        dedupeKey: text("dedupe_key").notNull(),

        /** The event that asked for it, where one did. */
        eventId: ulidFk("event_id").references(() => domainEvent.id, {
            onDelete: "set null",
        }),
        customerId: ulidFk("customer_id").references(() => customer.id, {
            onDelete: "set null",
        }),
        /** What it is about, for the admin list and for „erneut senden". */
        entityType: text("entity_type"),
        entityId: text("entity_id"),

        toEmail: text("to_email").notNull(),
        toName: text("to_name"),

        /**
         * What the template needs to render. Amounts as they were, the
         * document number, the storage key of a PDF to attach — never a
         * figure the renderer would have to look up again, because a mail
         * sent on Tuesday must say what was true on Tuesday.
         */
        payload: jsonb("payload").notNull().default({}),

        status: emailStatus("status").notNull().default("pending"),
        attempts: integer("attempts").notNull().default(0),
        maxAttempts: integer("max_attempts").notNull().default(5),
        runAfter: timestamp("run_after"),
        /** When the current claim was taken. A stale one becomes `unknown`. */
        claimedAt: timestamp("claimed_at"),

        /**
         * The subject and the plaintext part **as they were delivered**,
         * written at send time.
         *
         * The HTML body is deliberately not kept: it is tens of kilobytes per
         * mail and would make this table a second document store. The text
         * part is the same message in a form a person reading the log can
         * actually read, and the admin page re-renders the HTML from the
         * payload for a preview — which may differ from what was sent if the
         * template has since changed, and says so. An invoice is the thing
         * that has to come back byte for byte; a notification is not.
         */
        subject: text("subject"),
        bodyText: text("body_text"),

        sentAt: timestamp("sent_at"),
        /** The RFC 5322 Message-ID, where the transport reported one. */
        messageId: text("message_id"),
        /** `smtp` or `graph` — which way out it actually took. */
        transport: text("transport"),
        lastError: text("last_error"),

        /** How many resends have been claimed off this row. */
        resendCount: integer("resend_count").notNull().default(0),
        /** The row this one is a resend of. */
        resendOfId: ulidFk("resend_of_id"),

        ...timestamps(),
    },
    (table) => [
        uniqueIndex("email_log_dedupe_idx").on(
            table.template,
            table.toEmail,
            table.dedupeKey,
        ),
        /** The outbox sweep's query. */
        index("email_log_runnable_idx").on(table.status, table.runAfter),
        index("email_log_customer_id_idx").on(table.customerId),
        index("email_log_entity_idx").on(table.entityType, table.entityId),
        index("email_log_event_id_idx").on(table.eventId),
    ],
);

export type DomainEventRow = typeof domainEvent.$inferSelect;
export type EmailLogRow = typeof emailLog.$inferSelect;
export type EmailStatus = (typeof emailStatus.enumValues)[number];
export type DomainEventStatusName =
    (typeof domainEventStatus.enumValues)[number];

/** A mail the sweep may pick up. The counterpart of `OPEN_INVOICE_STATUSES`. */
export const RUNNABLE_EMAIL_STATUSES = ["pending", "failed"] as const;

/**
 * Whether this row is still going to be attempted. `sending` is somebody
 * else's claim and `unknown` is deliberately not runnable — see the enum.
 */
export function isRunnableEmail(status: EmailStatus): boolean {
    return (RUNNABLE_EMAIL_STATUSES as readonly string[]).includes(status);
}
