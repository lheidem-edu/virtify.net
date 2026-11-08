import type {
    ChannelSubscription,
    DeltaPage,
    InboundMessage,
    MailChannel,
    OutboundMessage,
    SentMessage,
} from "@/server/tickets/channels/types";

/**
 * A mail channel made of hand-written messages.
 *
 * There are no tenant credentials for this installation and none are to be
 * gone looking for, so every test drives the pipeline through this instead
 * of through Microsoft. It records what it was asked to do — what was marked
 * read, what was moved, what was sent — because half the claims worth making
 * about the pipeline are claims about *that*.
 */

export type FakeChannelOptions = {
    messages?: InboundMessage[];
    /** Ids the next delta query reports. Defaults to every message's id. */
    deltaIds?: string[];
    attachments?: Record<string, Buffer>;
    /** Throw this instead of answering `getMessage`. */
    failOn?: Record<string, Error>;
};

export type FakeChannel = MailChannel & {
    readonly markedRead: string[];
    readonly moved: { id: string; folder: string }[];
    readonly sent: { mailbox: string; message: OutboundMessage }[];
    readonly subscriptions: ChannelSubscription[];
    readonly deleted: string[];
    add(message: InboundMessage): void;
    /** Next `send` throws. */
    breakSending(): void;
    renewCount: number;
};

let counter = 0;

/**
 * Module-level, not per channel. Graph never hands out the same subscription
 * id twice, and `mail_subscription.subscription_id` is unique across removed
 * rows too — a per-instance counter made a second fake channel collide with
 * a subscription the first one had already had removed.
 */
let subscriptionCounter = 0;

/** Same reasoning: `ticket_message.internet_message_id` is globally unique. */
let sentCounter = 0;

export function inboundMessage(
    over: Partial<InboundMessage> = {},
): InboundMessage {
    counter += 1;

    return {
        channelMessageId: `AAMk${counter}`,
        internetMessageId: `<m${counter}@example.net>`,
        conversationId: `conv-${counter}`,
        subject: "Server nicht erreichbar",
        from: { email: "maria@example.net", name: "Maria Musterfrau" },
        sender: { email: "maria@example.net", name: "Maria Musterfrau" },
        to: [{ email: "support@example.net", name: "Support" }],
        cc: [],
        receivedAt: new Date("2026-11-08T09:00:00.000Z"),
        bodyHtml: "<div>Seit heute Morgen ist der Server weg.</div>",
        bodyText: null,
        headers: {},
        hasAttachments: false,
        attachments: [],
        isDraft: false,
        ...over,
    };
}

export function fakeChannel(options: FakeChannelOptions = {}): FakeChannel {
    const messages = new Map(
        (options.messages ?? []).map((message) => [
            message.channelMessageId,
            message,
        ]),
    );
    const markedRead: string[] = [];
    const moved: { id: string; folder: string }[] = [];
    const sent: { mailbox: string; message: OutboundMessage }[] = [];
    const subscriptions: ChannelSubscription[] = [];
    const deleted: string[] = [];
    let sendBroken = false;

    const channel: FakeChannel = {
        id: "msgraph",
        markedRead,
        moved,
        sent,
        subscriptions,
        deleted,
        renewCount: 0,

        add(message) {
            messages.set(message.channelMessageId, message);
        },

        breakSending() {
            sendBroken = true;
        },

        async getMessage(_mailbox, id) {
            const failure = options.failOn?.[id];

            if (failure) {
                throw failure;
            }

            return messages.get(id) ?? null;
        },

        async listDelta(_mailbox, _deltaLink): Promise<DeltaPage> {
            return {
                messageIds: options.deltaIds ?? [...messages.keys()],
                deltaLink: "https://graph.invalid/delta?token=next",
            };
        },

        async downloadAttachment(_mailbox, _messageId, attachmentId) {
            return options.attachments?.[attachmentId] ?? null;
        },

        async markRead(_mailbox, id) {
            markedRead.push(id);
        },

        async moveToFolder(_mailbox, id, folder) {
            moved.push({ id, folder });

            const message = messages.get(id);
            const movedId = `${id}-moved`;

            if (message) {
                // A move mints a new id — the whole reason the claim is
                // keyed on the Message-ID and not on this one.
                messages.delete(id);
                messages.set(movedId, {
                    ...message,
                    channelMessageId: movedId,
                });
            }

            return movedId;
        },

        async send(mailbox, message): Promise<SentMessage> {
            if (sendBroken) {
                throw new Error("the mailbox refused the send");
            }

            sentCounter += 1;
            sent.push({ mailbox, message });

            return {
                channelMessageId: `sent-${sentCounter}`,
                internetMessageId: `<out${sentCounter}@example.net>`,
                conversationId: "conv-out",
            };
        },

        async createSubscription(input) {
            subscriptionCounter += 1;

            const subscription: ChannelSubscription = {
                subscriptionId: `sub-${subscriptionCounter}`,
                resource: `/users/${input.mailbox}/mailFolders('inbox')/messages`,
                expiresAt: new Date(Date.now() + input.minutes * 60_000),
            };

            subscriptions.push(subscription);

            return subscription;
        },

        async renewSubscription(subscriptionId, minutes) {
            channel.renewCount += 1;

            const found = subscriptions.find(
                (entry) => entry.subscriptionId === subscriptionId,
            );

            const renewed: ChannelSubscription = {
                subscriptionId,
                resource: found?.resource ?? "",
                expiresAt: new Date(Date.now() + minutes * 60_000),
            };

            if (found) {
                found.expiresAt = renewed.expiresAt;
            }

            return renewed;
        },

        async deleteSubscription(subscriptionId) {
            deleted.push(subscriptionId);
        },
    };

    return channel;
}
