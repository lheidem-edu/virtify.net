import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
    bigint,
    boolean,
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
import { customer, customerContact } from "./customers";
import { invoice } from "./invoices";
import { staffUser } from "./staff";
import { service } from "./subscriptions";

/**
 * Ticketing, and the mailbox it is fed from.
 *
 * The domain is deliberately channel-agnostic: a ticket, its messages and
 * its attachments say nothing about Microsoft Graph. What a channel knows —
 * the provider's own message id, the folder it is in, the delta cursor — is
 * kept in the mailbox tables at the bottom of this file, so a second channel
 * (IMAP, a web form, a chat widget) is a new implementation and not a new
 * column on `ticket`.
 */

export const ticketStatus = pgEnum("ticket_status", [
    /** Waiting for us. A customer reply puts a ticket back here. */
    "open",
    /** Answered; waiting for the customer. */
    "waiting",
    /** Deliberately parked — no reply expected and no reminder wanted. */
    "on_hold",
    "closed",
]);

export const ticketPriority = pgEnum("ticket_priority", [
    "low",
    "normal",
    "high",
    "urgent",
]);

export const ticketMessageDirection = pgEnum("ticket_message_direction", [
    /** From the customer, or from anybody who wrote to the mailbox. */
    "inbound",
    /** From us, sent through the channel. */
    "outbound",
    /** Staff only. Never leaves the building. */
    "note",
]);

export const ticketMessageAuthor = pgEnum("ticket_message_author", [
    "customer",
    "staff",
    "system",
]);

/**
 * A queue with a mailbox behind it. Mail that arrives in that mailbox
 * becomes a ticket in that department; a reply goes back out from it.
 */
export const ticketDepartment = pgTable(
    "ticket_department",
    {
        id: ulidPk("ticketdepartment"),
        name: text("name").notNull(),
        slug: text("slug").notNull().unique(),
        /**
         * The shared mailbox, as an address. Lower-cased on write: Exchange
         * does not care about case and neither may the lookup that decides
         * which department an incoming message belongs to.
         */
        mailbox: text("mailbox").notNull(),
        /** Which implementation drives that mailbox. */
        channel: text("channel").notNull().default("msgraph"),
        /** Where a message with no department of its own lands. */
        isDefault: boolean("is_default").notNull().default(false),
        active: boolean("active").notNull().default(true),
        /** Shown to the customer when they open a ticket in the portal. */
        description: text("description"),
        ...timestamps(),
    },
    (table) => [
        index("ticket_department_mailbox_idx").on(table.mailbox),
        /**
         * One department per mailbox. Two would make "which queue does this
         * message belong to" a coin toss, and the answer would differ
         * between a notification and the delta reconciliation.
         */
        uniqueIndex("ticket_department_mailbox_unique_idx").on(table.mailbox),
    ],
);

export const ticket = pgTable(
    "ticket",
    {
        id: ulidPk("ticket"),
        /**
         * The number in `[TKT-00042]`. Sequential and never reused — it is
         * the strongest threading signal there is, and a number handed out
         * twice would silently join two customers' conversations.
         * Deliberately **not** per year, for the same reason.
         */
        number: integer("number").notNull().unique(),

        departmentId: ulidFk("department_id")
            .notNull()
            .references(() => ticketDepartment.id),

        /**
         * Null when the sender matched no contact. Such a ticket is visible
         * to staff only — see `unknownSender` — and gets its customer when
         * somebody assigns one.
         */
        customerId: ulidFk("customer_id").references(() => customer.id, {
            onDelete: "set null",
        }),
        /** Which contact of that account wrote, when one matched. */
        contactId: ulidFk("contact_id").references(() => customerContact.id, {
            onDelete: "set null",
        }),
        /**
         * True while no contact matched the sender. It is a flag for staff,
         * not a status: a ticket can be linked to a customer and still have
         * arrived from an address nobody knows.
         */
        unknownSender: boolean("unknown_sender").notNull().default(false),

        subject: text("subject").notNull(),
        status: ticketStatus("status").notNull().default("open"),
        priority: ticketPriority("priority").notNull().default("normal"),
        assigneeId: ulidFk("assignee_id").references(() => staffUser.id, {
            onDelete: "set null",
        }),

        /** Who wrote first, as the mail said it. Kept even once linked. */
        requesterEmail: text("requester_email").notNull(),
        requesterName: text("requester_name"),

        /**
         * The channel's own thread handle — Graph's `conversationId`. The
         * last threading fallback, and only within one mailbox.
         */
        conversationId: text("conversation_id"),

        /** What this ticket is about, when it is about something. */
        serviceId: ulidFk("service_id").references(() => service.id, {
            onDelete: "set null",
        }),
        invoiceId: ulidFk("invoice_id").references(() => invoice.id, {
            onDelete: "set null",
        }),

        firstResponseAt: timestamp("first_response_at"),
        lastMessageAt: timestamp("last_message_at").notNull().defaultNow(),
        closedAt: timestamp("closed_at"),

        /**
         * Merging is reversible, so it is a pointer rather than a deletion.
         * A merged ticket keeps its number and its row; its messages move,
         * each remembering where it came from (`ticket_message.merged_from_
         * ticket_id`), which is what makes the way back exact.
         */
        mergedIntoTicketId: ulidFk("merged_into_ticket_id").references(
            (): AnyPgColumn => ticket.id,
            { onDelete: "set null" },
        ),
        mergedAt: timestamp("merged_at"),

        ...timestamps(),
    },
    (table) => [
        index("ticket_status_idx").on(table.status),
        index("ticket_customer_idx").on(table.customerId),
        index("ticket_department_idx").on(table.departmentId),
        index("ticket_assignee_idx").on(table.assigneeId),
        index("ticket_conversation_idx").on(table.conversationId),
        index("ticket_last_message_idx").on(table.lastMessageAt),
    ],
);

export const ticketMessage = pgTable(
    "ticket_message",
    {
        id: ulidPk("ticketmessage"),
        ticketId: ulidFk("ticket_id")
            .notNull()
            .references(() => ticket.id, { onDelete: "cascade" }),

        direction: ticketMessageDirection("direction").notNull(),
        authorType: ticketMessageAuthor("author_type").notNull(),
        /** Staff user id, customer contact id, or null for the system. */
        authorId: ulidFk("author_id"),
        authorName: text("author_name"),
        authorEmail: text("author_email"),

        subject: text("subject"),
        /** Recipients as the message carried them. */
        toAddresses: jsonb("to_addresses")
            .$type<{ email: string; name?: string | null }[]>()
            .notNull()
            .default([]),
        ccAddresses: jsonb("cc_addresses")
            .$type<{ email: string; name?: string | null }[]>()
            .notNull()
            .default([]),

        /**
         * What the conversation view shows: the new part, with the quoted
         * history and the signature taken off.
         */
        displayText: text("display_text").notNull().default(""),
        displayHtml: text("display_html"),
        /**
         * The message as it arrived, sanitised but **not** trimmed. Stripping
         * is a display decision and it is sometimes wrong — the part it
         * removed may be the part that matters — so the whole of it is kept
         * and the detail page can show it.
         */
        originalHtml: text("original_html"),
        originalText: text("original_text"),

        /**
         * RFC 5322 Message-ID, including the angle brackets. Unique across
         * the installation: this is what makes turning one mail into one
         * ticket message the **database's** guarantee rather than the
         * pipeline's. `inbound_mail` is only the cheap layer in front of it.
         */
        internetMessageId: text("internet_message_id"),
        inReplyTo: text("in_reply_to"),
        references: text("references").array().notNull().default([]),
        /** The channel's own id for the message, as it is *now*. */
        channelMessageId: text("channel_message_id"),
        conversationId: text("conversation_id"),

        /** Our own copy, so an inbound message that is ours is recognisable. */
        isAutomated: boolean("is_automated").notNull().default(false),

        sentAt: timestamp("sent_at").notNull().defaultNow(),

        /** Set while this message sits in a ticket it was merged into. */
        mergedFromTicketId: ulidFk("merged_from_ticket_id").references(
            () => ticket.id,
            { onDelete: "set null" },
        ),

        ...timestamps(),
    },
    (table) => [
        index("ticket_message_ticket_idx").on(table.ticketId, table.sentAt),
        uniqueIndex("ticket_message_internet_id_idx").on(
            table.internetMessageId,
        ),
        index("ticket_message_in_reply_to_idx").on(table.inReplyTo),
        index("ticket_message_channel_id_idx").on(table.channelMessageId),
    ],
);

export const ticketAttachment = pgTable(
    "ticket_attachment",
    {
        id: ulidPk("ticketattachment"),
        messageId: ulidFk("message_id")
            .notNull()
            .references(() => ticketMessage.id, { onDelete: "cascade" }),
        filename: text("filename").notNull(),
        contentType: text("content_type").notNull(),
        sizeBytes: integer("size_bytes").notNull(),
        /** Where the bytes are, in `src/server/storage`. */
        storageKey: text("storage_key").notNull(),
        sha256: text("sha256").notNull(),
        /** `cid:` reference for an image embedded in the body. */
        contentId: text("content_id"),
        isInline: boolean("is_inline").notNull().default(false),
        ...timestamps(),
    },
    (table) => [
        index("ticket_attachment_message_idx").on(table.messageId),
        uniqueIndex("ticket_attachment_key_idx").on(table.storageKey),
    ],
);

/** Boilerplate a member of staff can drop into a reply. */
export const ticketCannedReply = pgTable("ticket_canned_reply", {
    id: ulidPk("ticketcannedreply"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Null means every department. */
    departmentId: ulidFk("department_id").references(
        () => ticketDepartment.id,
        { onDelete: "cascade" },
    ),
    ...timestamps(),
});

// ---------------------------------------------------------------------------
// The mailbox side: everything a channel needs and nothing a ticket does.
// ---------------------------------------------------------------------------

/**
 * The channel's configuration. One row per channel id, shaped like
 * `payment_gateway_setting`: the secrets are one encrypted blob (hard rule
 * 6), everything that is not a secret is a column so the admin area can read
 * it back.
 */
export const mailChannelSetting = pgTable("mail_channel_setting", {
    /** `msgraph` today. */
    id: text("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    /** AES-256-GCM, `src/lib/crypto.ts`. Never leaves the server. */
    credentials: text("credentials"),
    /** The folder processed mail is moved to. Created if it is missing. */
    processedFolder: text("processed_folder").notNull().default("Processed"),
    /** Attachments larger than this are recorded and not downloaded. */
    maxAttachmentBytes: bigint("max_attachment_bytes", { mode: "number" })
        .notNull()
        .default(20 * 1024 * 1024),
    /** How many automatic replies one sender may provoke per hour. */
    autoReplyPerHour: integer("auto_reply_per_hour").notNull().default(4),
    /** Which mailbox the system's own mail (invoices, Mahnungen) goes out from. */
    outboundSender: text("outbound_sender"),
    /** `graph` sends through this channel; `smtp` keeps nodemailer. */
    transport: text("transport").notNull().default("smtp"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Per-mailbox state the channel keeps between runs: the delta cursor and the
 * folder ids it has already looked up.
 */
export const mailboxState = pgTable("mailbox_state", {
    mailbox: text("mailbox").primaryKey(),
    /** Graph's `@odata.deltaLink`. Null means "start from now". */
    deltaLink: text("delta_link"),
    deltaAt: timestamp("delta_at"),
    inboxFolderId: text("inbox_folder_id"),
    processedFolderId: text("processed_folder_id"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * A change-notification subscription at the provider.
 *
 * `clientStateHash` is the hash of the secret we handed the provider when we
 * created it — hashed exactly as an API key is, because that is what it is:
 * the only authorization an unauthenticated webhook route has.
 */
export const mailSubscription = pgTable(
    "mail_subscription",
    {
        id: ulidPk("mailsubscription"),
        channel: text("channel").notNull().default("msgraph"),
        mailbox: text("mailbox").notNull(),
        resource: text("resource").notNull(),
        /** The provider's own id for the subscription. */
        subscriptionId: text("subscription_id").notNull().unique(),
        clientStateHash: text("client_state_hash").notNull(),
        expiresAt: timestamp("expires_at").notNull(),
        lastRenewedAt: timestamp("last_renewed_at"),
        /** Cleared rather than deleted, so a late notification is explainable. */
        removedAt: timestamp("removed_at"),
        ...timestamps(),
    },
    (table) => [
        index("mail_subscription_mailbox_idx").on(table.mailbox),
        index("mail_subscription_expires_idx").on(table.expiresAt),
    ],
);

/**
 * A notification that arrived at the webhook, waiting to be looked at.
 *
 * The route writes one of these and nothing else. Nothing in the payload
 * names a ticket, a customer or an invoice — it names a *message in a
 * mailbox we already know about*, and the job then fetches that message from
 * the provider itself. A forged notification can therefore cause a lookup
 * and nothing more.
 */
export const mailNotification = pgTable(
    "mail_notification",
    {
        id: ulidPk("mailnotification"),
        channel: text("channel").notNull().default("msgraph"),
        mailbox: text("mailbox").notNull(),
        subscriptionId: text("subscription_id").notNull(),
        /** The provider's message id, as the notification gave it. */
        resourceId: text("resource_id").notNull(),
        changeType: text("change_type").notNull(),
        receivedAt: timestamp("received_at").notNull().defaultNow(),
        /** Set by a drain that ran to the end. */
        handledAt: timestamp("handled_at"),
        attempts: integer("attempts").notNull().default(0),
        lastError: text("last_error"),
        ...timestamps(),
    },
    (table) => [
        /**
         * One pending row per message per mailbox. A burst of notifications
         * for the same message is one fetch, not five — and a row that has
         * already been handled is taken back by the same upsert, because a
         * *later* change to the same message deserves another look.
         */
        uniqueIndex("mail_notification_message_idx").on(
            table.mailbox,
            table.resourceId,
        ),
        index("mail_notification_pending_idx").on(table.handledAt),
    ],
);

/**
 * The claim on one email message. See `src/server/tickets/inbound.ts`.
 *
 * Keyed on the mailbox and the RFC 5322 Message-ID, because that is what
 * one *message* is: the provider's own id changes the moment the message is
 * moved to another folder, which is the last thing the pipeline does to it.
 */
export const inboundMail = pgTable(
    "inbound_mail",
    {
        id: ulidPk("inboundmail"),
        channel: text("channel").notNull().default("msgraph"),
        mailbox: text("mailbox").notNull(),
        internetMessageId: text("internet_message_id").notNull(),
        channelMessageId: text("channel_message_id"),
        fromEmail: text("from_email"),
        subject: text("subject"),
        receivedAt: timestamp("received_at"),
        attempts: integer("attempts").notNull().default(1),
        /** Only a handler that ran to the end sets this. */
        handledAt: timestamp("handled_at"),
        /** `ticket`, `ignored` — and why, for the ones that were ignored. */
        outcome: text("outcome"),
        reason: text("reason"),
        ticketId: ulidFk("ticket_id").references(() => ticket.id, {
            onDelete: "set null",
        }),
        ticketMessageId: ulidFk("ticket_message_id").references(
            () => ticketMessage.id,
            { onDelete: "set null" },
        ),
        ...timestamps(),
    },
    (table) => [
        uniqueIndex("inbound_mail_message_idx").on(
            table.mailbox,
            table.internetMessageId,
        ),
        index("inbound_mail_handled_idx").on(table.handledAt),
    ],
);

/**
 * How many automatic replies one sender has already provoked in the current
 * hour. A row is claimed with a conditional update, so the budget is the
 * database's answer and not a count somebody read a moment ago.
 */
export const autoReplyBudget = pgTable(
    "auto_reply_budget",
    {
        id: ulidPk("autoreplybudget"),
        /** Lower-cased sender address. */
        recipient: text("recipient").notNull(),
        /** The hour this budget is for, as `YYYY-MM-DDTHH` in UTC. */
        window: text("window").notNull(),
        count: integer("count").notNull().default(0),
        ...timestamps(),
    },
    (table) => [
        uniqueIndex("auto_reply_budget_idx").on(table.recipient, table.window),
    ],
);

export type TicketDepartment = typeof ticketDepartment.$inferSelect;
export type Ticket = typeof ticket.$inferSelect;
export type TicketMessage = typeof ticketMessage.$inferSelect;
export type TicketAttachment = typeof ticketAttachment.$inferSelect;
export type TicketCannedReply = typeof ticketCannedReply.$inferSelect;
export type MailSubscription = typeof mailSubscription.$inferSelect;
export type MailNotification = typeof mailNotification.$inferSelect;
export type InboundMail = typeof inboundMail.$inferSelect;
export type TicketStatus = (typeof ticketStatus.enumValues)[number];
export type TicketPriority = (typeof ticketPriority.enumValues)[number];
export type TicketMessageDirection =
    (typeof ticketMessageDirection.enumValues)[number];
