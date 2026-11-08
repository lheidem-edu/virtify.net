import { describe, expect, it } from "vitest";
import {
    flattenHeaders,
    GraphError,
    graphChannel,
    normalizeGraphMessage,
} from "@/server/tickets/channels/graph";

/**
 * The Graph client, driven by a recorded `fetch`.
 *
 * There are no tenant credentials for this installation and none are to be
 * gone looking for, so the payloads below are written by hand against the
 * documented contract. What is actually being asserted is the shape of the
 * conversation: which URLs, in which order, and what the client does with
 * what comes back.
 */

type Call = { url: string; method: string; body: unknown };

function recorder(routes: ([RegExp, unknown] | [RegExp, unknown, number])[]): {
    fetch: typeof fetch;
    calls: Call[];
} {
    const calls: Call[] = [];

    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        let body: unknown = null;

        if (typeof init?.body === "string") {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }

        calls.push({ url, method, body });

        for (const [pattern, payload, status] of routes) {
            if (pattern.test(url)) {
                return new Response(
                    payload === null ? null : JSON.stringify(payload),
                    {
                        status: status ?? (payload === null ? 204 : 200),
                        headers: { "content-type": "application/json" },
                    },
                );
            }
        }

        return new Response(JSON.stringify({ error: { code: "NotFound" } }), {
            status: 404,
        });
    }) as unknown as typeof fetch;

    return { fetch: impl, calls };
}

const TOKEN: [RegExp, unknown] = [
    /login\.microsoftonline\.com/,
    { access_token: "t0ken", expires_in: 3600 },
];

const AUTH = {
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
};

describe("normalizeGraphMessage", () => {
    it("reads a message the way the pipeline needs it", () => {
        const message = normalizeGraphMessage({
            id: "AAMkAGI2",
            internetMessageId: "  <abc@example.net>  ",
            conversationId: "conv1",
            subject: "[TKT-00042] Server down",
            from: {
                emailAddress: { address: "Maria@Example.NET", name: "Maria" },
            },
            toRecipients: [
                { emailAddress: { address: "support@example.net" } },
            ],
            receivedDateTime: "2026-11-08T09:00:00Z",
            body: { contentType: "html", content: "<p>Hilfe</p>" },
            hasAttachments: false,
            internetMessageHeaders: [
                { name: "In-Reply-To", value: "<old@example.net>" },
            ],
        });

        // Addresses are lower-cased, because nothing else in this system
        // compares them case-insensitively.
        expect(message.from?.email).toBe("maria@example.net");
        expect(message.internetMessageId).toBe("<abc@example.net>");
        expect(message.bodyHtml).toBe("<p>Hilfe</p>");
        expect(message.bodyText).toBeNull();
        expect(message.headers["in-reply-to"]).toBe("<old@example.net>");
    });

    it("puts a text body in the text slot and not the HTML one", () => {
        const message = normalizeGraphMessage({
            id: "x",
            body: { contentType: "text", content: "nur Text" },
        });

        expect(message.bodyText).toBe("nur Text");
        expect(message.bodyHtml).toBeNull();
    });

    it("treats a missing internetMessageId as missing, not as empty", () => {
        expect(
            normalizeGraphMessage({ id: "x", internetMessageId: "  " })
                .internetMessageId,
        ).toBeNull();
    });
});

describe("flattenHeaders", () => {
    it("lower-cases the names and joins repeats", () => {
        expect(
            flattenHeaders([
                { name: "References", value: "<a@x.net>" },
                { name: "references", value: "<b@x.net>" },
                { name: "X-Auto-Response-Suppress", value: "All" },
            ]),
        ).toEqual({
            references: "<a@x.net>, <b@x.net>",
            "x-auto-response-suppress": "All",
        });
    });
});

describe("the channel", () => {
    it("fetches a token once and reuses it", async () => {
        const { fetch, calls } = recorder([
            TOKEN,
            [/\/messages\//, { id: "AAMk", subject: "x" }],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        await channel.getMessage("support@example.net", "AAMk");
        await channel.getMessage("support@example.net", "AAMk");

        const tokens = calls.filter((call) =>
            call.url.includes("microsoftonline"),
        );

        expect(tokens).toHaveLength(1);
        expect(tokens[0].method).toBe("POST");
    });

    it("never puts the client secret in the error it throws", async () => {
        const { fetch } = recorder([
            [/login\.microsoftonline\.com/, { error: "invalid_client" }, 401],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        await expect(
            channel.getMessage("support@example.net", "AAMk"),
        ).rejects.toThrow(/Graph refused the client credentials/);

        await expect(
            channel.getMessage("support@example.net", "AAMk"),
        ).rejects.not.toThrow(/secret/);
    });

    it("answers null for a message that is gone rather than throwing", async () => {
        const { fetch } = recorder([TOKEN]);
        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        expect(
            await channel.getMessage("support@example.net", "weg"),
        ).toBeNull();
    });

    it("fetches the attachment list only when there are attachments", async () => {
        const { fetch, calls } = recorder([
            TOKEN,
            [
                /\/attachments\?/,
                {
                    value: [
                        {
                            id: "att1",
                            name: "bild.png",
                            contentType: "image/png",
                            size: 1234,
                            isInline: true,
                            contentId: "<logo>",
                        },
                    ],
                },
            ],
            [/\/messages\//, { id: "AAMk", hasAttachments: true }],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });
        const message = await channel.getMessage("support@example.net", "AAMk");

        expect(message?.attachments).toEqual([
            {
                id: "att1",
                filename: "bild.png",
                contentType: "image/png",
                sizeBytes: 1234,
                isInline: true,
                // The angle brackets are what a `cid:` reference does not have.
                contentId: "logo",
            },
        ]);

        expect(calls.some((call) => call.url.includes("/attachments?"))).toBe(
            true,
        );
    });

    it("follows every delta page and only then keeps the deltaLink", async () => {
        let page = 0;
        const { fetch } = recorder([
            TOKEN,
            [
                /delta/,
                // One route, two answers — the recorder replays the same
                // entry, so the body is built per call.
                null,
            ],
        ]);

        const paging = (async (
            input: RequestInfo | URL,
            init?: RequestInit,
        ) => {
            const url = String(input);

            if (url.includes("microsoftonline")) {
                return fetch(input, init);
            }

            page += 1;

            return new Response(
                JSON.stringify(
                    page === 1
                        ? {
                              value: [{ id: "a" }, { id: "b" }],
                              "@odata.nextLink":
                                  "https://graph.microsoft.com/v1.0/next",
                          }
                        : {
                              value: [{ id: "c" }, { "@removed": {} }],
                              "@odata.deltaLink":
                                  "https://graph.microsoft.com/v1.0/delta?token=2",
                          },
                ),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        }) as unknown as typeof fetch;

        const channel = graphChannel({ auth: AUTH, fetchImpl: paging });
        const result = await channel.listDelta("support@example.net", null);

        expect(result.messageIds).toEqual(["a", "b", "c"]);
        expect(result.deltaLink).toBe(
            "https://graph.microsoft.com/v1.0/delta?token=2",
        );
    });

    it("creates the processed folder when it is missing, and moves into it", async () => {
        const { fetch, calls } = recorder([
            TOKEN,
            [/mailFolders\?\$filter/, { value: [] }],
            [/mailFolders$/, { id: "folder-new" }],
            [/\/move$/, { id: "AAMk-moved" }],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });
        const id = await channel.moveToFolder(
            "support@example.net",
            "AAMk",
            "Processed",
        );

        // The new id is the point: a move mints one, and the caller has to
        // learn it or it is addressing a message that no longer exists.
        expect(id).toBe("AAMk-moved");

        const create = calls.find(
            (call) =>
                call.method === "POST" && call.url.endsWith("mailFolders"),
        );

        expect(create?.body).toEqual({ displayName: "Processed" });

        const move = calls.find((call) => call.url.endsWith("/move"));

        expect(move?.body).toEqual({ destinationId: "folder-new" });
    });

    it("reuses a processed folder that is already there", async () => {
        const { fetch, calls } = recorder([
            TOKEN,
            [/mailFolders\?\$filter/, { value: [{ id: "folder-1" }] }],
            [/\/move$/, { id: "moved" }],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        await channel.moveToFolder("support@example.net", "AAMk", "Processed");

        expect(
            calls.some(
                (call) =>
                    call.method === "POST" && call.url.endsWith("mailFolders"),
            ),
        ).toBe(false);
    });

    it("sends a reply as a draft, reads its id back, then sends it", async () => {
        const { fetch, calls } = recorder([
            TOKEN,
            [/createReply$/, { id: "draft-1" }],
            [
                /messages\/draft-1\?\$select/,
                {
                    internetMessageId: "<new@example.net>",
                    conversationId: "conv1",
                },
            ],
            [/messages\/draft-1\/send$/, null],
            [/messages\/draft-1$/, { id: "draft-1" }],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        const sent = await channel.send("support@example.net", {
            to: [{ email: "maria@example.net", name: "Maria" }],
            subject: "[TKT-00042] Server down",
            html: "<p>Antwort</p>",
            text: "Antwort",
            replyToChannelMessageId: "AAMk",
        });

        expect(sent.internetMessageId).toBe("<new@example.net>");

        const order = calls
            .filter((call) => !call.url.includes("microsoftonline"))
            .map((call) => `${call.method} ${call.url.split("/v1.0")[1]}`);

        // The read comes before the send: once sent, the draft moves to Sent
        // Items and its id changes with it.
        expect(order).toEqual([
            "POST /users/support%40example.net/messages/AAMk/createReply",
            "PATCH /users/support%40example.net/messages/draft-1",
            "GET /users/support%40example.net/messages/draft-1?$select=internetMessageId,conversationId",
            "POST /users/support%40example.net/messages/draft-1/send",
        ]);

        // createReply prefills recipients and quotes the original; both are
        // overwritten, because who a reply goes to is the ticket's business.
        const patch = calls.find((call) => call.method === "PATCH");

        expect(patch?.body).toMatchObject({
            subject: "[TKT-00042] Server down",
            toRecipients: [
                {
                    emailAddress: {
                        address: "maria@example.net",
                        name: "Maria",
                    },
                },
            ],
        });
    });

    it("creates a plain draft when there is nothing to reply to", async () => {
        const { fetch, calls } = recorder([
            TOKEN,
            [/messages\/draft-2\?\$select/, { internetMessageId: "<x@y.net>" }],
            [/messages\/draft-2\/send$/, null],
            [/users\/[^/]+\/messages$/, { id: "draft-2" }],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        await channel.send("support@example.net", {
            to: [{ email: "maria@example.net" }],
            subject: "Neu",
            html: "<p>x</p>",
            text: "x",
        });

        expect(calls.some((call) => call.url.includes("createReply"))).toBe(
            false,
        );
        // No PATCH either: the draft was created with everything on it.
        expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    });

    it("asks for no more than Graph's subscription ceiling", async () => {
        const { fetch, calls } = recorder([
            TOKEN,
            [
                /\/subscriptions$/,
                {
                    id: "sub-1",
                    resource:
                        "/users/support@example.net/mailFolders('inbox')/messages",
                    expirationDateTime: "2026-11-11T09:00:00Z",
                },
            ],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        await channel.createSubscription({
            mailbox: "support@example.net",
            notificationUrl: "https://virtify.net/api/webhooks/msgraph",
            clientState: "secret-state",
            minutes: 100_000,
        });

        const body = calls.find((call) => call.url.endsWith("/subscriptions"))
            ?.body as { expirationDateTime: string; clientState: string };

        const minutes =
            (new Date(body.expirationDateTime).getTime() - Date.now()) / 60_000;

        expect(minutes).toBeLessThanOrEqual(4230);
        expect(minutes).toBeGreaterThan(4220);
        expect(body.clientState).toBe("secret-state");
    });

    it("treats deleting a subscription that is already gone as done", async () => {
        const { fetch } = recorder([TOKEN]);
        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        await expect(
            channel.deleteSubscription("sub-gone"),
        ).resolves.toBeUndefined();
    });

    it("carries the status on the error, so a caller can tell gone from broken", async () => {
        const { fetch } = recorder([
            TOKEN,
            [/\/messages\//, { error: { code: "ErrorAccessDenied" } }, 403],
        ]);

        const channel = graphChannel({ auth: AUTH, fetchImpl: fetch });

        await expect(
            channel.getMessage("support@example.net", "AAMk"),
        ).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof GraphError &&
                error.status === 403 &&
                error.code === "ErrorAccessDenied" &&
                !error.gone,
        );
    });
});
