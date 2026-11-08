import "server-only";
import type {
    ChannelSubscription,
    DeltaPage,
    InboundMessage,
    MailAddress,
    MailChannel,
    MailHeaders,
    SentMessage,
} from "./types";

/**
 * Microsoft Graph, over `fetch` and nothing else.
 *
 * No SDK (hard rule 12): the whole of what this needs is eight endpoints and
 * a client-credentials token, and `@microsoft/microsoft-graph-client` would
 * bring its own fetch polyfill, its own auth provider abstraction and a
 * major version to track for that.
 *
 * **The app is expected to be restricted to the support mailbox** by an
 * Exchange Application Access Policy or an RBAC management scope — see
 * `docs/m365-setup.md`. `Mail.ReadWrite` as an *application* permission is
 * otherwise every mailbox in the tenant, which is not what a ticket system
 * needs and not what an auditor will accept.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Everything the pipeline reads off a message, in one $select. */
const MESSAGE_SELECT = [
    "id",
    "internetMessageId",
    "conversationId",
    "subject",
    "from",
    "sender",
    "toRecipients",
    "ccRecipients",
    "receivedDateTime",
    "body",
    "hasAttachments",
    "isDraft",
    "internetMessageHeaders",
].join(",");

/**
 * An attachment this size or smaller goes up inline with the draft; anything
 * larger needs an upload session. Graph's documented limit for a single
 * `POST /attachments` is 3 MB.
 */
export const INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

/** Graph's ceiling for a message subscription is 4230 minutes. */
export const MAX_SUBSCRIPTION_MINUTES = 4230;

export class GraphError extends Error {
    constructor(
        readonly status: number,
        readonly code: string | null,
        message: string,
    ) {
        super(message);
        this.name = "GraphError";
    }

    /** The message is no longer where we were told to look. */
    get gone(): boolean {
        return this.status === 404 || this.status === 410;
    }
}

export type GraphAuth = {
    tenantId: string;
    clientId: string;
    clientSecret: string;
};

type TokenCache = { token: string; expiresAt: number };

export type GraphFetch = typeof fetch;

export type GraphChannelOptions = {
    auth: GraphAuth;
    /** Injected in tests; the recorded payloads live in `tests/helpers/graph.ts`. */
    fetchImpl?: GraphFetch;
    /** The folder processed mail is moved into. */
    processedFolder?: string;
};

function addresses(
    list: { emailAddress?: { address?: string; name?: string } }[] | undefined,
): MailAddress[] {
    return (list ?? [])
        .map((entry) => ({
            email: (entry.emailAddress?.address ?? "").toLowerCase(),
            name: entry.emailAddress?.name ?? null,
        }))
        .filter((entry) => entry.email !== "");
}

function address(value: {
    emailAddress?: { address?: string; name?: string };
}): MailAddress | null {
    return addresses([value])[0] ?? null;
}

/**
 * Graph hands headers back as a list of `{name, value}` pairs, with the case
 * the sender used and sometimes more than one entry for the same name
 * (`Received`, `References`). Lower-cased keys, and repeats joined with a
 * comma, which is what RFC 5322 §3.2.2 allows for the ones this reads.
 */
export function flattenHeaders(
    list: { name?: string; value?: string }[] | undefined,
): MailHeaders {
    const headers: MailHeaders = {};

    for (const entry of list ?? []) {
        const name = (entry.name ?? "").trim().toLowerCase();

        if (!name) {
            continue;
        }

        const value = (entry.value ?? "").trim();

        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }

    return headers;
}

export function normalizeGraphMessage(raw: {
    id?: string;
    internetMessageId?: string | null;
    conversationId?: string | null;
    subject?: string | null;
    from?: { emailAddress?: { address?: string; name?: string } } | null;
    sender?: { emailAddress?: { address?: string; name?: string } } | null;
    toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
    ccRecipients?: { emailAddress?: { address?: string; name?: string } }[];
    receivedDateTime?: string;
    body?: { contentType?: string; content?: string } | null;
    hasAttachments?: boolean;
    isDraft?: boolean;
    internetMessageHeaders?: { name?: string; value?: string }[];
}): InboundMessage {
    const html =
        raw.body?.contentType?.toLowerCase() === "html"
            ? (raw.body?.content ?? null)
            : null;
    const text =
        raw.body?.contentType?.toLowerCase() === "html"
            ? null
            : (raw.body?.content ?? null);

    return {
        channelMessageId: raw.id ?? "",
        internetMessageId: raw.internetMessageId?.trim() || null,
        conversationId: raw.conversationId ?? null,
        subject: raw.subject ?? "",
        from: raw.from ? address(raw.from) : null,
        sender: raw.sender ? address(raw.sender) : null,
        to: addresses(raw.toRecipients),
        cc: addresses(raw.ccRecipients),
        receivedAt: raw.receivedDateTime
            ? new Date(raw.receivedDateTime)
            : new Date(),
        bodyHtml: html,
        bodyText: text,
        headers: flattenHeaders(raw.internetMessageHeaders),
        hasAttachments: Boolean(raw.hasAttachments),
        attachments: [],
        isDraft: Boolean(raw.isDraft),
    };
}

export function graphChannel(options: GraphChannelOptions): MailChannel {
    const doFetch = options.fetchImpl ?? fetch;
    let token: TokenCache | null = null;

    async function accessToken(): Promise<string> {
        // A minute of slack, so a token that expires while the request is in
        // flight is renewed rather than rejected.
        if (token && token.expiresAt > Date.now() + 60_000) {
            return token.token;
        }

        const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: options.auth.clientId,
            client_secret: options.auth.clientSecret,
            scope: "https://graph.microsoft.com/.default",
        });

        const response = await doFetch(
            `https://login.microsoftonline.com/${encodeURIComponent(
                options.auth.tenantId,
            )}/oauth2/v2.0/token`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                },
                body,
            },
        );

        if (!response.ok) {
            const detail = await response.text().catch(() => "");

            throw new GraphError(
                response.status,
                "token",
                // Deliberately not the body of the request: it holds the
                // client secret, and this message reaches a log.
                `Graph refused the client credentials (${response.status}): ${detail.slice(0, 300)}`,
            );
        }

        const payload = (await response.json()) as {
            access_token: string;
            expires_in: number;
        };

        token = {
            token: payload.access_token,
            expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
        };

        return token.token;
    }

    async function call<T>(
        path: string,
        init: RequestInit & { raw?: boolean } = {},
    ): Promise<T> {
        const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
        const response = await doFetch(url, {
            ...init,
            headers: {
                authorization: `Bearer ${await accessToken()}`,
                ...(init.body && !init.raw
                    ? { "content-type": "application/json" }
                    : {}),
                ...(init.headers ?? {}),
            },
        });

        if (response.status === 204) {
            return undefined as T;
        }

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            let code: string | null = null;

            try {
                code =
                    (JSON.parse(text) as { error?: { code?: string } })?.error
                        ?.code ?? null;
            } catch {
                code = null;
            }

            throw new GraphError(
                response.status,
                code,
                `Graph ${init.method ?? "GET"} ${path} failed (${response.status} ${code ?? ""}): ${text.slice(0, 300)}`,
            );
        }

        if (init.raw) {
            return Buffer.from(await response.arrayBuffer()) as T;
        }

        return (await response.json()) as T;
    }

    const user = (mailbox: string) =>
        `/users/${encodeURIComponent(mailbox.toLowerCase())}`;

    async function folderId(mailbox: string, name: string): Promise<string> {
        const found = await call<{ value: { id: string }[] }>(
            `${user(mailbox)}/mailFolders?$filter=displayName eq '${name.replace(
                /'/g,
                "''",
            )}'&$select=id&$top=1`,
        );

        const existing = found.value?.[0]?.id;

        if (existing) {
            return existing;
        }

        const created = await call<{ id: string }>(
            `${user(mailbox)}/mailFolders`,
            {
                method: "POST",
                body: JSON.stringify({ displayName: name }),
            },
        );

        return created.id;
    }

    async function attachmentsOf(
        mailbox: string,
        messageId: string,
    ): Promise<InboundMessage["attachments"]> {
        const result = await call<{
            value: {
                id: string;
                name?: string;
                contentType?: string;
                size?: number;
                isInline?: boolean;
                contentId?: string | null;
                "@odata.type"?: string;
            }[];
        }>(
            `${user(mailbox)}/messages/${encodeURIComponent(
                messageId,
            )}/attachments?$select=id,name,contentType,size,isInline,contentId`,
        );

        return (result.value ?? []).map((entry) => ({
            id: entry.id,
            filename: entry.name ?? "anhang",
            contentType: entry.contentType ?? "application/octet-stream",
            sizeBytes: entry.size ?? 0,
            isInline: Boolean(entry.isInline),
            contentId: entry.contentId?.replace(/^<|>$/g, "") || null,
        }));
    }

    return {
        id: "msgraph",

        async getMessage(mailbox, channelMessageId) {
            try {
                const raw = await call<
                    Parameters<typeof normalizeGraphMessage>[0]
                >(
                    `${user(mailbox)}/messages/${encodeURIComponent(
                        channelMessageId,
                    )}?$select=${MESSAGE_SELECT}`,
                );

                const message = normalizeGraphMessage(raw);

                if (message.hasAttachments) {
                    message.attachments = await attachmentsOf(
                        mailbox,
                        channelMessageId,
                    );
                }

                return message;
            } catch (error) {
                // Gone is an answer, not a failure: the message was moved,
                // deleted, or processed by an earlier pass that already
                // moved it into Processed and so changed its id.
                if (error instanceof GraphError && error.gone) {
                    return null;
                }

                throw error;
            }
        },

        async listDelta(mailbox, deltaLink): Promise<DeltaPage> {
            let url =
                deltaLink ??
                `${GRAPH}${user(
                    mailbox,
                )}/mailFolders('inbox')/messages/delta?$select=id`;

            const messageIds: string[] = [];
            let nextDelta: string | null = null;

            // Follow every page. A reconciliation that stopped at the first
            // one would advance nothing, because the deltaLink only arrives
            // with the last page.
            for (let page = 0; page < 100; page += 1) {
                const result: {
                    value?: { id?: string; "@removed"?: unknown }[];
                    "@odata.nextLink"?: string;
                    "@odata.deltaLink"?: string;
                } = await call(url);

                for (const entry of result.value ?? []) {
                    // A removal tells us a message left the inbox — which is
                    // what *we* do to it. Nothing to fetch.
                    if (entry["@removed"] || !entry.id) {
                        continue;
                    }

                    messageIds.push(entry.id);
                }

                if (result["@odata.deltaLink"]) {
                    nextDelta = result["@odata.deltaLink"];
                    break;
                }

                if (!result["@odata.nextLink"]) {
                    break;
                }

                url = result["@odata.nextLink"];
            }

            return { messageIds, deltaLink: nextDelta };
        },

        async downloadAttachment(mailbox, channelMessageId, attachmentId) {
            try {
                return await call<Buffer>(
                    `${user(mailbox)}/messages/${encodeURIComponent(
                        channelMessageId,
                    )}/attachments/${encodeURIComponent(attachmentId)}/$value`,
                    { raw: true },
                );
            } catch (error) {
                if (error instanceof GraphError && error.gone) {
                    return null;
                }

                throw error;
            }
        },

        async markRead(mailbox, channelMessageId) {
            await call(
                `${user(mailbox)}/messages/${encodeURIComponent(channelMessageId)}`,
                { method: "PATCH", body: JSON.stringify({ isRead: true }) },
            );
        },

        async moveToFolder(mailbox, channelMessageId, folder) {
            const destinationId = await folderId(mailbox, folder);

            const moved = await call<{ id?: string }>(
                `${user(mailbox)}/messages/${encodeURIComponent(
                    channelMessageId,
                )}/move`,
                { method: "POST", body: JSON.stringify({ destinationId }) },
            );

            // The move mints a new id. Returning it is what lets the caller
            // record where the message actually is now.
            return moved.id ?? null;
        },

        async send(mailbox, message): Promise<SentMessage> {
            const recipients = (list: MailAddress[] | undefined) =>
                (list ?? []).map((entry) => ({
                    emailAddress: {
                        address: entry.email,
                        name: entry.name ?? undefined,
                    },
                }));

            /**
             * Always through a draft, never `sendMail`.
             *
             * `POST /sendMail` returns 202 and nothing else — no id at all —
             * and a reply whose Message-ID we never learn is a reply our own
             * loop protection cannot recognise when it comes back to us.
             * Exchange assigns `internetMessageId` when the draft is
             * created, so the draft route is the only one that can be read
             * back before it goes.
             */
            const draft = message.replyToChannelMessageId
                ? await call<{ id: string }>(
                      `${user(mailbox)}/messages/${encodeURIComponent(
                          message.replyToChannelMessageId,
                      )}/createReply`,
                      { method: "POST" },
                  )
                : await call<{ id: string }>(`${user(mailbox)}/messages`, {
                      method: "POST",
                      body: JSON.stringify({
                          subject: message.subject,
                          toRecipients: recipients(message.to),
                          ccRecipients: recipients(message.cc),
                          body: { contentType: "HTML", content: message.html },
                      }),
                  });

            if (message.replyToChannelMessageId) {
                // `createReply` prefills the recipients from the message it
                // replies to and the body with the quoted original. Both are
                // overwritten: who a reply goes to is the ticket's business,
                // and the quoted original is already in the ticket.
                await call(
                    `${user(mailbox)}/messages/${encodeURIComponent(draft.id)}`,
                    {
                        method: "PATCH",
                        body: JSON.stringify({
                            subject: message.subject,
                            toRecipients: recipients(message.to),
                            ccRecipients: recipients(message.cc),
                            body: {
                                contentType: "HTML",
                                content: message.html,
                            },
                        }),
                    },
                );
            }

            for (const attachment of message.attachments ?? []) {
                if (attachment.content.byteLength <= INLINE_ATTACHMENT_LIMIT) {
                    await call(
                        `${user(mailbox)}/messages/${encodeURIComponent(
                            draft.id,
                        )}/attachments`,
                        {
                            method: "POST",
                            body: JSON.stringify({
                                "@odata.type":
                                    "#microsoft.graph.fileAttachment",
                                name: attachment.filename,
                                contentType: attachment.contentType,
                                contentBytes:
                                    attachment.content.toString("base64"),
                            }),
                        },
                    );

                    continue;
                }

                await uploadLargeAttachment(draft.id, attachment);
            }

            // Read the id Exchange minted *before* sending: once sent, the
            // draft moves to Sent Items and its id changes with it.
            const read = await call<{
                internetMessageId?: string | null;
                conversationId?: string | null;
            }>(
                `${user(mailbox)}/messages/${encodeURIComponent(
                    draft.id,
                )}?$select=internetMessageId,conversationId`,
            );

            await call(
                `${user(mailbox)}/messages/${encodeURIComponent(draft.id)}/send`,
                { method: "POST" },
            );

            return {
                channelMessageId: draft.id,
                internetMessageId: read.internetMessageId?.trim() || null,
                conversationId: read.conversationId ?? null,
            };

            async function uploadLargeAttachment(
                draftId: string,
                attachment: {
                    filename: string;
                    contentType: string;
                    content: Buffer;
                },
            ) {
                const session = await call<{ uploadUrl: string }>(
                    `${user(mailbox)}/messages/${encodeURIComponent(
                        draftId,
                    )}/attachments/createUploadSession`,
                    {
                        method: "POST",
                        body: JSON.stringify({
                            AttachmentItem: {
                                attachmentType: "file",
                                name: attachment.filename,
                                size: attachment.content.byteLength,
                                contentType: attachment.contentType,
                            },
                        }),
                    },
                );

                // 320 KiB is the multiple Graph asks every chunk but the
                // last to be a whole number of.
                const chunk = 320 * 1024 * 10;
                const total = attachment.content.byteLength;

                for (let offset = 0; offset < total; offset += chunk) {
                    const end = Math.min(offset + chunk, total) - 1;
                    const slice = attachment.content.subarray(offset, end + 1);

                    // The upload URL carries its own token in the query
                    // string; sending the bearer as well is what Graph
                    // answers 401 to.
                    const response = await doFetch(session.uploadUrl, {
                        method: "PUT",
                        headers: {
                            "content-length": String(slice.byteLength),
                            "content-range": `bytes ${offset}-${end}/${total}`,
                        },
                        body: new Uint8Array(slice),
                    });

                    if (!response.ok && response.status !== 201) {
                        throw new GraphError(
                            response.status,
                            "uploadSession",
                            `the upload session rejected bytes ${offset}-${end}`,
                        );
                    }
                }
            }
        },

        async createSubscription(input): Promise<ChannelSubscription> {
            const resource = `/users/${input.mailbox.toLowerCase()}/mailFolders('inbox')/messages`;
            const minutes = Math.min(input.minutes, MAX_SUBSCRIPTION_MINUTES);

            const created = await call<{
                id: string;
                resource: string;
                expirationDateTime: string;
            }>("/subscriptions", {
                method: "POST",
                body: JSON.stringify({
                    changeType: "created",
                    notificationUrl: input.notificationUrl,
                    resource,
                    expirationDateTime: new Date(
                        Date.now() + minutes * 60_000,
                    ).toISOString(),
                    clientState: input.clientState,
                }),
            });

            return {
                subscriptionId: created.id,
                resource: created.resource ?? resource,
                expiresAt: new Date(created.expirationDateTime),
            };
        },

        async renewSubscription(subscriptionId, minutes) {
            const renewed = await call<{
                id: string;
                resource: string;
                expirationDateTime: string;
            }>(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
                method: "PATCH",
                body: JSON.stringify({
                    expirationDateTime: new Date(
                        Date.now() +
                            Math.min(minutes, MAX_SUBSCRIPTION_MINUTES) *
                                60_000,
                    ).toISOString(),
                }),
            });

            return {
                subscriptionId: renewed.id,
                resource: renewed.resource,
                expiresAt: new Date(renewed.expirationDateTime),
            };
        },

        async deleteSubscription(subscriptionId) {
            try {
                await call(
                    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
                    { method: "DELETE" },
                );
            } catch (error) {
                // One that is already gone is the state we wanted.
                if (error instanceof GraphError && error.gone) {
                    return;
                }

                throw error;
            }
        },
    };
}
