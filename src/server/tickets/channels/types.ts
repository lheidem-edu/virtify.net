/**
 * What a mail channel has to be able to do, and in what shape it answers.
 *
 * Nothing above this interface knows the word "Graph". The pipeline in
 * `src/server/tickets/inbound.ts` asks for a message, gets the same struct
 * whatever drove it, and hands back a decision; the channel does the moving
 * and the marking. That is what makes the inbound logic testable without a
 * tenant — every test in `tests/unit/tickets-*.test.ts` and
 * `tests/integration/tickets-inbound.test.ts` drives a channel made of
 * recorded payloads.
 */

export type MailAddress = {
    email: string;
    name?: string | null;
};

/**
 * The headers the pipeline actually reads, lower-cased and flattened. A
 * channel that cannot supply them supplies an empty object, and the loop
 * protection then falls back on what it can see.
 */
export type MailHeaders = Record<string, string>;

export type InboundAttachment = {
    /** The channel's own id for the attachment. */
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    isInline: boolean;
    /** `cid:` value for an inline image, without the angle brackets. */
    contentId: string | null;
};

export type InboundMessage = {
    /** The channel's id for the message **as it is now**. It changes on a move. */
    channelMessageId: string;
    /** RFC 5322 Message-ID with its angle brackets, or null if the mail had none. */
    internetMessageId: string | null;
    conversationId: string | null;
    subject: string;
    from: MailAddress | null;
    /** The envelope sender, where the channel exposes it. A bounce has none. */
    sender: MailAddress | null;
    to: MailAddress[];
    cc: MailAddress[];
    receivedAt: Date;
    bodyHtml: string | null;
    bodyText: string | null;
    headers: MailHeaders;
    hasAttachments: boolean;
    attachments: InboundAttachment[];
    isDraft: boolean;
};

export type OutboundMessage = {
    to: MailAddress[];
    cc?: MailAddress[];
    subject: string;
    html: string;
    text: string;
    attachments?: {
        filename: string;
        contentType: string;
        content: Buffer;
    }[];
    /**
     * The channel message id of what is being replied to, where there is
     * one. A channel that can reply in place keeps the provider's own
     * threading headers; otherwise it sends a fresh message and relies on
     * `inReplyTo`/`references` below.
     */
    replyToChannelMessageId?: string | null;
    inReplyTo?: string | null;
    references?: string[];
};

export type SentMessage = {
    channelMessageId: string | null;
    internetMessageId: string | null;
    conversationId: string | null;
};

export type DeltaPage = {
    /**
     * The channel's ids for what changed. Ids rather than whole messages on
     * purpose: a delta query cannot return everything a message has — Graph
     * will not `$select` `internetMessageHeaders` on one — so reconciliation
     * fetches each message through exactly the same path a notification
     * does, and there is only one way a message ever reaches the pipeline.
     */
    messageIds: string[];
    /** Hand this back next time. Null when the channel lost its place. */
    deltaLink: string | null;
};

export type ChannelSubscription = {
    subscriptionId: string;
    resource: string;
    expiresAt: Date;
};

export interface MailChannel {
    readonly id: string;

    /** Null when the provider no longer has it — moved, deleted, or purged. */
    getMessage(
        mailbox: string,
        channelMessageId: string,
    ): Promise<InboundMessage | null>;

    /**
     * Everything that changed since `deltaLink`. With none, the channel
     * starts a fresh delta and returns the messages currently in the inbox,
     * which is what makes a first run pick up the backlog.
     */
    listDelta(mailbox: string, deltaLink: string | null): Promise<DeltaPage>;

    downloadAttachment(
        mailbox: string,
        channelMessageId: string,
        attachmentId: string,
    ): Promise<Buffer | null>;

    markRead(mailbox: string, channelMessageId: string): Promise<void>;

    /**
     * Moves the message into `folder`, creating the folder if it is missing.
     * Returns the message's **new** id, because the provider mints one.
     */
    moveToFolder(
        mailbox: string,
        channelMessageId: string,
        folder: string,
    ): Promise<string | null>;

    send(mailbox: string, message: OutboundMessage): Promise<SentMessage>;

    createSubscription(input: {
        mailbox: string;
        notificationUrl: string;
        clientState: string;
        /** How long to ask for. The provider may grant less. */
        minutes: number;
    }): Promise<ChannelSubscription>;

    renewSubscription(
        subscriptionId: string,
        minutes: number,
    ): Promise<ChannelSubscription>;

    deleteSubscription(subscriptionId: string): Promise<void>;
}
