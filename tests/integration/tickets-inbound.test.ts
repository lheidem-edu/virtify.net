import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@/lib/ulid";
import {
    documentStorage,
    localStorage,
    setDocumentStorage,
} from "@/server/storage";
import { deleteAttachment, readAttachment } from "@/server/tickets/attachments";
import {
    claimAutoReply,
    releaseAutoReply,
    syntheticMessageId,
} from "@/server/tickets/claim";
import {
    processInboundMessage,
    reopenInboundMail,
} from "@/server/tickets/inbound";
import {
    replyRecipients,
    replyToTicket,
    sendTicketConfirmation,
} from "@/server/tickets/outbound";
import { handleMessage, reconcileMailbox } from "@/server/tickets/reconcile";
import { ANY_CUSTOMER, attachmentInScope } from "@/server/tickets/repository";
import {
    addInternalNote,
    mergeTickets,
    unmergeTicket,
} from "@/server/tickets/service";
import { DEFAULT_MAIL_CHANNEL } from "@/server/tickets/settings";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";
import {
    contactEmail,
    makeCustomer,
    makeDepartment,
} from "../helpers/fixtures";
import { fakeChannel, inboundMessage } from "../helpers/graph";

/**
 * The inbound pipeline, against a real Postgres.
 *
 * Every claim here is about what rows a transaction leaves behind — which is
 * the one thing a mock cannot be wrong about in the way the database can.
 * The channel is a fake, because there are no tenant credentials for this
 * installation and none are to be gone looking for.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the ticketing proofs are being\n" +
            "        SKIPPED. Run `npm run db:up`.\n",
    );
}

const MAILBOX = "support@example.test";

describe.skipIf(!available)("inbound mail becomes a ticket", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let storageRoot: string;
    let seq = 70_000;

    async function nextCustomer() {
        seq += 1;

        const customerId = await makeCustomer(db, seq);

        return { customerId, email: await contactEmail(db, customerId) };
    }

    function options(channel: ReturnType<typeof fakeChannel>, id: string) {
        return {
            channel,
            mailbox: MAILBOX,
            channelMessageId: id,
            ownAddresses: [MAILBOX],
            processedFolder: "Processed",
            maxAttachmentBytes: DEFAULT_MAIL_CHANNEL.maxAttachmentBytes,
        };
    }

    beforeAll(async () => {
        const created = await createTestDatabase();

        db = created.db;
        drop = created.drop;
        storageRoot = await mkdtemp(path.join(tmpdir(), "virtify-tickets-"));
        setDocumentStorage(localStorage(storageRoot));

        await makeDepartment(db, { mailbox: MAILBOX });
    });

    afterAll(async () => {
        setDocumentStorage(null);
        await rm(storageRoot, { recursive: true, force: true });
        await drop();
    });

    it("opens a ticket, numbers it and links the sender's account", async () => {
        const { customerId, email } = await nextCustomer();
        const message = inboundMessage({
            from: { email, name: "Maria" },
            subject: "Server nicht erreichbar",
        });
        const channel = fakeChannel({ messages: [message] });

        const result = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        expect(result.kind).toBe("filed");

        if (result.kind !== "filed") {
            return;
        }

        expect(result.createdTicket).toBe(true);
        expect(result.matchedBy).toBe("new");
        expect(result.unknownSender).toBe(false);
        expect(result.ticketNumber).toBeGreaterThan(0);

        const [ticket] = await db
            .select()
            .from(schema.ticket)
            .where(eq(schema.ticket.id, result.ticketId));

        expect(ticket.customerId).toBe(customerId);
        expect(ticket.unknownSender).toBe(false);
        expect(ticket.status).toBe("open");
        expect(ticket.requesterEmail).toBe(email);

        // Marked read and moved out of the inbox, in that order.
        expect(channel.markedRead).toContain(message.channelMessageId);
        expect(channel.moved).toEqual([
            { id: message.channelMessageId, folder: "Processed" },
        ]);

        // The move minted a new provider id, and the message row learned it.
        const [stored] = await db
            .select()
            .from(schema.ticketMessage)
            .where(eq(schema.ticketMessage.id, result.ticketMessageId));

        expect(stored.channelMessageId).toBe(
            `${message.channelMessageId}-moved`,
        );
        expect(stored.internetMessageId).toBe(message.internetMessageId);
    });

    it("flags a sender nobody knows and leaves the ticket without an account", async () => {
        const message = inboundMessage({
            from: { email: "fremd@example.org", name: null },
        });
        const channel = fakeChannel({ messages: [message] });

        const result = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        expect(result).toMatchObject({ kind: "filed", unknownSender: true });

        if (result.kind !== "filed") {
            return;
        }

        const [ticket] = await db
            .select()
            .from(schema.ticket)
            .where(eq(schema.ticket.id, result.ticketId));

        expect(ticket.customerId).toBeNull();
        expect(ticket.unknownSender).toBe(true);
    });

    it("files a second delivery of the same message exactly once", async () => {
        const { email } = await nextCustomer();
        const message = inboundMessage({ from: { email } });
        const channel = fakeChannel({ messages: [message] });

        const first = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        expect(first.kind).toBe("filed");

        // The provider re-delivers under the id the move minted — which is a
        // *different* id for the same message. The claim is keyed on the
        // Message-ID precisely so this is recognised.
        const second = await processInboundMessage(
            db,
            options(channel, `${message.channelMessageId}-moved`),
        );

        expect(second.kind).toBe("duplicate");

        // And the claim stopped it *before* the pipeline ran: the message
        // was not fetched, moved or marked read a second time. Counting
        // ticket rows alone cannot tell "skipped" from "the unique index
        // rolled it back", which is the trap Phase 6 fell into.
        expect(channel.moved).toHaveLength(1);
        expect(channel.markedRead).toHaveLength(1);

        const rows = await db
            .select()
            .from(schema.ticketMessage)
            .where(
                eq(
                    schema.ticketMessage.internetMessageId,
                    message.internetMessageId ?? "",
                ),
            );

        expect(rows).toHaveLength(1);
    });

    it("re-runs a message whose claim was never finished", async () => {
        const { email } = await nextCustomer();
        const message = inboundMessage({ from: { email } });
        const channel = fakeChannel({ messages: [message] });

        // A pass that died between the commit and `markInboundHandled`.
        const claimed = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        expect(claimed.kind).toBe("filed");

        await db
            .update(schema.inboundMail)
            .set({ handledAt: null, outcome: null })
            .where(
                eq(
                    schema.inboundMail.internetMessageId,
                    message.internetMessageId ?? "",
                ),
            );

        const retry = await processInboundMessage(
            db,
            options(channel, `${message.channelMessageId}-moved`),
        );

        // Claimable again, and the unique index is what stops it doubling.
        expect(retry.kind).toBe("duplicate");

        const [row] = await db
            .select()
            .from(schema.inboundMail)
            .where(
                eq(
                    schema.inboundMail.internetMessageId,
                    message.internetMessageId ?? "",
                ),
            );

        expect(row.handledAt).not.toBeNull();
        expect(row.outcome).toBe("duplicate");
        expect(row.attempts).toBe(2);
    });

    describe("threading", () => {
        it("joins a reply by the ticket number in the subject", async () => {
            const { email } = await nextCustomer();
            const first = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [first] });

            const opened = await processInboundMessage(
                db,
                options(channel, first.channelMessageId),
            );

            expect(opened.kind).toBe("filed");

            if (opened.kind !== "filed") {
                throw new Error(`the first message was ${opened.kind}`);
            }

            const tag = `TKT-${String(opened.ticketNumber).padStart(5, "0")}`;
            const reply = inboundMessage({
                from: { email },
                subject: `AW: [${tag}] Server nicht erreichbar`,
                // Deliberately nothing else to go on: no In-Reply-To, and a
                // conversation id of its own.
                conversationId: "andere-konversation",
                headers: {},
            });

            channel.add(reply);

            const result = await processInboundMessage(
                db,
                options(channel, reply.channelMessageId),
            );

            expect(result).toMatchObject({
                kind: "filed",
                ticketId: opened.ticketId,
                createdTicket: false,
                matchedBy: "subject-tag",
            });
        });

        /**
         * Who a ticket belongs to, and what is allowed to change that.
         *
         * A ticket number is sequential and travels on a subject line, so a
         * signal anybody can produce must not be able to move a ticket into
         * somebody's account — the portal scopes on `customer_id`, so that
         * would hand over the whole conversation.
         */
        describe("adopting an unowned ticket", () => {
            async function strangerTicket() {
                const opening = inboundMessage({
                    from: { email: "fremder@example.org", name: "Fremder" },
                    subject: "Abuse-Meldung",
                });
                const channel = fakeChannel({ messages: [opening] });

                const opened = await processInboundMessage(
                    db,
                    options(channel, opening.channelMessageId),
                );

                if (opened.kind !== "filed") {
                    throw new Error(`the opening mail was ${opened.kind}`);
                }

                const [row] = await db
                    .select()
                    .from(schema.ticket)
                    .where(eq(schema.ticket.id, opened.ticketId))
                    .limit(1);

                // The premise: it really is unowned to begin with.
                expect(row.customerId).toBeNull();
                expect(row.unknownSender).toBe(true);

                return { opened, channel, opening };
            }

            it("refuses a subject tag, which anybody can guess", async () => {
                const { opened, channel } = await strangerTicket();
                const { customerId, email } = await nextCustomer();

                const tag = `TKT-${String(opened.ticketNumber).padStart(5, "0")}`;

                channel.add(
                    inboundMessage({
                        channelMessageId: "AAMk-guess",
                        internetMessageId: "<guess@example.net>",
                        from: { email, name: "Angreifer" },
                        subject: `[${tag}] Frage`,
                        conversationId: "eigene-konversation",
                        headers: {},
                    }),
                );

                const result = await processInboundMessage(
                    db,
                    options(channel, "AAMk-guess"),
                );

                // It is filed — a stray sender is filed and flagged, not
                // dropped — but it changes nothing about who owns the thread.
                expect(result).toMatchObject({
                    kind: "filed",
                    ticketId: opened.ticketId,
                    matchedBy: "subject-tag",
                });

                const [row] = await db
                    .select()
                    .from(schema.ticket)
                    .where(eq(schema.ticket.id, opened.ticketId))
                    .limit(1);

                expect(row.customerId).toBeNull();
                expect(row.contactId).toBeNull();

                // And the decisive consequence: it is not in their portal.
                const { listTickets } = await import(
                    "@/server/tickets/repository"
                );
                const mine = await listTickets(customerId, {}, db);

                expect(
                    mine.rows.some((entry) => entry.id === opened.ticketId),
                ).toBe(false);
            });

            it("accepts an In-Reply-To, which it cannot", async () => {
                const { opened, opening, channel } = await strangerTicket();
                const { customerId, email } = await nextCustomer();

                channel.add(
                    inboundMessage({
                        channelMessageId: "AAMk-reply",
                        internetMessageId: "<echt@example.net>",
                        from: { email, name: "Dieselbe Person" },
                        subject: "ganz anderer Betreff",
                        conversationId: "noch-eine-konversation",
                        headers: {
                            "in-reply-to": opening.internetMessageId ?? "",
                        },
                    }),
                );

                expect(
                    await processInboundMessage(
                        db,
                        options(channel, "AAMk-reply"),
                    ),
                ).toMatchObject({
                    kind: "filed",
                    ticketId: opened.ticketId,
                    matchedBy: "message-id",
                });

                const [row] = await db
                    .select()
                    .from(schema.ticket)
                    .where(eq(schema.ticket.id, opened.ticketId))
                    .limit(1);

                expect(row.customerId).toBe(customerId);
            });
        });

        it("joins a reply by In-Reply-To when the subject says nothing", async () => {
            const { email } = await nextCustomer();
            const first = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [first] });

            const opened = await processInboundMessage(
                db,
                options(channel, first.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("the first message was not filed");
            }

            const reply = inboundMessage({
                from: { email },
                subject: "ganz anderer Betreff",
                conversationId: "andere-konversation",
                headers: {
                    "in-reply-to": first.internetMessageId ?? "",
                },
            });

            channel.add(reply);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: opened.ticketId,
                matchedBy: "message-id",
            });
        });

        it("joins by References when In-Reply-To is absent", async () => {
            const { email } = await nextCustomer();
            const first = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [first] });

            const opened = await processInboundMessage(
                db,
                options(channel, first.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("the first message was not filed");
            }

            const reply = inboundMessage({
                from: { email },
                subject: "anders",
                conversationId: "andere-konversation",
                headers: {
                    references: `<fremd@example.org> ${first.internetMessageId}`,
                },
            });

            channel.add(reply);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: opened.ticketId,
                matchedBy: "message-id",
            });
        });

        it("falls back to the conversation id, and only within the mailbox", async () => {
            const { email } = await nextCustomer();
            const first = inboundMessage({
                from: { email },
                conversationId: "conv-shared",
            });
            const channel = fakeChannel({ messages: [first] });

            const opened = await processInboundMessage(
                db,
                options(channel, first.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("the first message was not filed");
            }

            const reply = inboundMessage({
                from: { email },
                subject: "nichts Verwertbares",
                conversationId: "conv-shared",
                headers: {},
            });

            channel.add(reply);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: opened.ticketId,
                matchedBy: "conversation",
            });
        });

        it("prefers the subject tag over a conversation that says otherwise", async () => {
            const { email } = await nextCustomer();
            const a = inboundMessage({
                from: { email },
                conversationId: "conv-a",
            });
            const b = inboundMessage({
                from: { email },
                conversationId: "conv-b",
            });
            const channel = fakeChannel({ messages: [a, b] });

            const first = await processInboundMessage(
                db,
                options(channel, a.channelMessageId),
            );
            const second = await processInboundMessage(
                db,
                options(channel, b.channelMessageId),
            );

            if (first.kind !== "filed" || second.kind !== "filed") {
                throw new Error("both messages should have been filed");
            }

            // Tag says the first ticket, conversation says the second. The
            // tag wins: it is the one signal that survives a reply sent from
            // another address, a forward, and a client that drops every
            // threading header.
            const tag = `TKT-${String(first.ticketNumber).padStart(5, "0")}`;
            const reply = inboundMessage({
                from: { email },
                subject: `AW: [${tag}] egal`,
                conversationId: "conv-b",
                headers: {},
            });

            channel.add(reply);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: first.ticketId,
                matchedBy: "subject-tag",
            });
        });

        it("prefers a stored Message-ID over a conversation that says otherwise", async () => {
            const { email } = await nextCustomer();
            const a = inboundMessage({
                from: { email },
                conversationId: "conv-c",
            });
            const b = inboundMessage({
                from: { email },
                conversationId: "conv-d",
            });
            const channel = fakeChannel({ messages: [a, b] });

            const first = await processInboundMessage(
                db,
                options(channel, a.channelMessageId),
            );
            const second = await processInboundMessage(
                db,
                options(channel, b.channelMessageId),
            );

            if (first.kind !== "filed" || second.kind !== "filed") {
                throw new Error("both messages should have been filed");
            }

            const reply = inboundMessage({
                from: { email },
                subject: "kein Kürzel",
                conversationId: "conv-d",
                headers: { "in-reply-to": a.internetMessageId ?? "" },
            });

            channel.add(reply);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: first.ticketId,
                matchedBy: "message-id",
            });
        });

        it("takes the newest ticket when a References chain names two", async () => {
            const { email } = await nextCustomer();
            const older = inboundMessage({ from: { email } });
            const newer = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [older, newer] });

            const first = await processInboundMessage(
                db,
                options(channel, older.channelMessageId),
            );
            const second = await processInboundMessage(
                db,
                options(channel, newer.channelMessageId),
            );

            if (first.kind !== "filed" || second.kind !== "filed") {
                throw new Error("both messages should have been filed");
            }

            // A forward that carries both threads' ids. The most recent one
            // is the one that says where the conversation actually is.
            const reply = inboundMessage({
                from: { email },
                subject: "kein Kürzel",
                conversationId: "egal",
                headers: {
                    references: `${older.internetMessageId} ${newer.internetMessageId}`,
                },
            });

            channel.add(reply);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: second.ticketId,
                matchedBy: "message-id",
            });
        });

        it("follows a merge on the conversation fallback too", async () => {
            const { email } = await nextCustomer();
            const a = inboundMessage({
                from: { email },
                conversationId: "conv-merged",
            });
            const b = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [a, b] });

            const source = await processInboundMessage(
                db,
                options(channel, a.channelMessageId),
            );
            const target = await processInboundMessage(
                db,
                options(channel, b.channelMessageId),
            );

            if (source.kind !== "filed" || target.kind !== "filed") {
                throw new Error("both messages should have been filed");
            }

            await mergeTickets(
                db,
                { sourceId: source.ticketId, targetId: target.ticketId },
                { type: "system", label: "test" },
            );

            const reply = inboundMessage({
                from: { email },
                subject: "kein Kürzel",
                conversationId: "conv-merged",
                headers: {},
            });

            channel.add(reply);

            // Not onto the closed source, where nobody would read it.
            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: target.ticketId,
                matchedBy: "conversation",
            });
        });

        it("opens a new ticket when nothing matches", async () => {
            const { email } = await nextCustomer();
            const message = inboundMessage({
                from: { email },
                subject: "[TKT-99999] gibt es nicht",
                headers: { "in-reply-to": "<unbekannt@example.org>" },
                conversationId: "conv-unbekannt",
            });
            const channel = fakeChannel({ messages: [message] });

            expect(
                await processInboundMessage(
                    db,
                    options(channel, message.channelMessageId),
                ),
            ).toMatchObject({ createdTicket: true, matchedBy: "new" });
        });

        it("reopens a closed ticket but leaves a parked one parked", async () => {
            const { email } = await nextCustomer();
            const first = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [first] });

            const opened = await processInboundMessage(
                db,
                options(channel, first.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("the first message was not filed");
            }

            const tag = `TKT-${String(opened.ticketNumber).padStart(5, "0")}`;

            for (const [before, expected] of [
                ["closed", "open"],
                ["on_hold", "on_hold"],
            ] as const) {
                await db
                    .update(schema.ticket)
                    .set({ status: before, closedAt: new Date() })
                    .where(eq(schema.ticket.id, opened.ticketId));

                const reply = inboundMessage({
                    from: { email },
                    subject: `[${tag}] nochmal`,
                    headers: {},
                });

                channel.add(reply);

                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                );

                const [ticket] = await db
                    .select()
                    .from(schema.ticket)
                    .where(eq(schema.ticket.id, opened.ticketId));

                expect(ticket.status).toBe(expected);
            }
        });
    });

    describe("loop protection", () => {
        it("records why it ignored a message and still moves it out", async () => {
            const message = inboundMessage({
                from: { email: "mailer-daemon@example.org" },
                headers: { "return-path": "<>" },
            });
            const channel = fakeChannel({ messages: [message] });

            const result = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            expect(result).toEqual({
                kind: "ignored",
                reason: "bounce",
            });

            const [row] = await db
                .select()
                .from(schema.inboundMail)
                .where(
                    eq(
                        schema.inboundMail.internetMessageId,
                        message.internetMessageId ?? "",
                    ),
                );

            expect(row.outcome).toBe("ignored");
            expect(row.reason).toBe("bounce");
            expect(row.handledAt).not.toBeNull();
            expect(row.ticketId).toBeNull();

            // Still moved: a message left in the inbox is one the next delta
            // pass picks up for ever.
            expect(channel.moved).toHaveLength(1);
        });

        it("files an automatic message and never acknowledges it", async () => {
            /**
             * The whole of the rule, end to end: a customer's monitoring
             * writes in, the message becomes a ticket so somebody sees it,
             * and no acknowledgement goes back — which is what would have
             * started a conversation between two machines.
             */
            const { email } = await nextCustomer();
            const message = inboundMessage({
                from: { email },
                subject: "ALARM: web01 antwortet nicht",
                headers: { "auto-submitted": "auto-generated" },
            });
            const channel = fakeChannel({ messages: [message] });

            const result = await handleMessage(
                db,
                {
                    channel,
                    config: {
                        ...DEFAULT_MAIL_CHANNEL,
                        id: "msgraph" as const,
                        label: "Graph",
                        enabled: true,
                    },
                },
                MAILBOX,
                message.channelMessageId,
                [MAILBOX],
                {
                    notifications: { handled: 0, failed: 0 },
                    delta: [],
                    results: {},
                    confirmations: 0,
                    failures: [],
                },
            );

            expect(result).toMatchObject({
                kind: "filed",
                createdTicket: true,
                automated: true,
            });

            if (result.kind !== "filed") {
                throw new Error("the alarm was not filed");
            }

            const [row] = await db
                .select()
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.id, result.ticketMessageId));

            expect(row.isAutomated).toBe(true);

            // And nothing was mailed back.
            expect(channel.sent).toEqual([]);
        });

        it("recognises our own outbound copy by the Message-ID we stored", async () => {
            const { email } = await nextCustomer();
            const first = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [first] });

            const opened = await processInboundMessage(
                db,
                options(channel, first.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("the first message was not filed");
            }

            const reply = await replyToTicket(
                db,
                channel,
                { ticketId: opened.ticketId, body: "Wir schauen nach." },
                { type: "system", label: "test" },
            );

            expect(reply.internetMessageId).not.toBeNull();

            // The mailbox is on a distribution list and gets its own copy.
            const echo = inboundMessage({
                from: { email: "maria@example.net" },
                internetMessageId: reply.internetMessageId,
            });

            channel.add(echo);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, echo.channelMessageId),
                ),
            ).toEqual({ kind: "ignored", reason: "own-outbound" });
        });

        it("refuses a message sent from our own mailbox", async () => {
            const message = inboundMessage({
                from: { email: MAILBOX.toUpperCase() },
            });
            const channel = fakeChannel({ messages: [message] });

            expect(
                await processInboundMessage(
                    db,
                    options(channel, message.channelMessageId),
                ),
            ).toEqual({ kind: "ignored", reason: "own-mailbox" });
        });

        it("never answers an automatic message, even when it opens a ticket", async () => {
            const { email } = await nextCustomer();
            // `precedence: bulk` is automatic but not a reason to refuse it.
            const message = inboundMessage({
                from: { email },
                headers: { precedence: "bulk" },
            });
            const channel = fakeChannel({ messages: [message] });
            const report = {
                notifications: { handled: 0, failed: 0 },
                delta: [],
                results: {},
                confirmations: 0,
                failures: [],
            };

            const result = await handleMessage(
                db,
                {
                    channel,
                    config: {
                        ...DEFAULT_MAIL_CHANNEL,
                        id: "msgraph" as const,
                        label: "Graph",
                        enabled: true,
                        autoReplyPerHour: 10,
                    },
                },
                MAILBOX,
                message.channelMessageId,
                [MAILBOX],
                report,
            );

            expect(result).toMatchObject({ kind: "filed", automated: true });
            expect(channel.sent).toHaveLength(0);
            expect(report.confirmations).toBe(0);
        });
    });

    describe("attachments", () => {
        it("stores what fits and records what does not", async () => {
            const { email } = await nextCustomer();
            const message = inboundMessage({
                from: { email },
                hasAttachments: true,
                attachments: [
                    {
                        id: "att-small",
                        filename: "../../etc/passwd",
                        contentType: "text/plain",
                        sizeBytes: 11,
                        isInline: false,
                        contentId: null,
                    },
                    {
                        id: "att-big",
                        filename: "dump.sql",
                        contentType: "application/sql",
                        sizeBytes: 50_000_000,
                        isInline: false,
                        contentId: null,
                    },
                ],
            });

            const channel = fakeChannel({
                messages: [message],
                attachments: { "att-small": Buffer.from("hallo datei") },
            });

            const result = await processInboundMessage(db, {
                ...options(channel, message.channelMessageId),
                maxAttachmentBytes: 1_000_000,
            });

            expect(result.kind).toBe("filed");

            if (result.kind !== "filed") {
                throw new Error(`the message was ${result.kind}`);
            }

            expect(result.skippedAttachments).toEqual([
                {
                    skipped: true,
                    filename: "dump.sql",
                    sizeBytes: 50_000_000,
                    reason: "too-large",
                },
            ]);

            const rows = await db
                .select()
                .from(schema.ticketAttachment)
                .where(
                    eq(
                        schema.ticketAttachment.messageId,
                        result.ticketMessageId,
                    ),
                );

            expect(rows).toHaveLength(1);
            /**
             * The sender's filename never reaches the storage key — the key
             * is a path on the filesystem in the local backend, and
             * `assertStorageKey` would refuse this one outright. The key
             * carries the attachment's own ULID and, here, no usable
             * extension at all, so `.bin`.
             */
            expect(rows[0].storageKey).toMatch(
                /^tickets\/ticket_[0-9A-Z]+\/ticketattachment_[0-9A-Z]+\.bin$/,
            );
            expect(rows[0].filename).toBe(".._.._etc_passwd");
            expect(rows[0].sizeBytes).toBe(11);
        });

        it("leaves no stored bytes behind when the message was a duplicate", async () => {
            const { email } = await nextCustomer();
            const message = inboundMessage({
                from: { email },
                hasAttachments: true,
                attachments: [
                    {
                        id: "att-dup",
                        filename: "bild.png",
                        contentType: "image/png",
                        sizeBytes: 5,
                        isInline: false,
                        contentId: null,
                    },
                ],
            });

            const channel = fakeChannel({
                messages: [message],
                attachments: { "att-dup": Buffer.from("12345") },
            });

            await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            // Second attempt on the same message: the claim is reopened so
            // the pipeline really runs again and downloads again.
            await db
                .update(schema.inboundMail)
                .set({ handledAt: null })
                .where(
                    eq(
                        schema.inboundMail.internetMessageId,
                        message.internetMessageId ?? "",
                    ),
                );

            const again = await processInboundMessage(
                db,
                options(channel, `${message.channelMessageId}-moved`),
            );

            expect(again.kind).toBe("duplicate");

            const rows = (
                await db.select().from(schema.ticketAttachment)
            ).filter((row) => row.filename === "bild.png");

            expect(rows).toHaveLength(1);

            /**
             * And the bytes the second attempt wrote are gone, not merely
             * unreferenced. A storage write is not transactional, so the
             * rollback cannot take it back — `removeOrphans` has to.
             */
            const ticketDir = path.join(
                storageRoot,
                path.dirname(rows[0].storageKey),
            );
            const files = await readdir(ticketDir);

            expect(files).toHaveLength(1);
            expect(
                path.join("tickets", path.basename(ticketDir), files[0]),
            ).toBe(rows[0].storageKey);
        });
    });

    describe("the automatic acknowledgement", () => {
        it("goes out once per sender within the budget and then stops", async () => {
            const { email } = await nextCustomer();

            expect(await claimAutoReply(db, email, 2)).toBe(true);
            expect(await claimAutoReply(db, email, 2)).toBe(true);
            expect(await claimAutoReply(db, email, 2)).toBe(false);

            // Case does not matter — the budget is per address.
            expect(await claimAutoReply(db, email.toUpperCase(), 2)).toBe(
                false,
            );
        });

        it("gives the allowance back when the send fails", async () => {
            const { email } = await nextCustomer();

            expect(await claimAutoReply(db, email, 1)).toBe(true);
            expect(await claimAutoReply(db, email, 1)).toBe(false);

            await releaseAutoReply(db, email);

            expect(await claimAutoReply(db, email, 1)).toBe(true);
        });

        it("refuses outright when the budget is zero", async () => {
            const { email } = await nextCustomer();

            expect(await claimAutoReply(db, email, 0)).toBe(false);
        });

        it("does not consume the allowance when the channel refuses", async () => {
            const { email } = await nextCustomer();
            const message = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [message] });

            const opened = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("the first message was not filed");
            }

            channel.breakSending();

            const failed = await sendTicketConfirmation(db, channel, {
                ticketId: opened.ticketId,
                limitPerHour: 1,
            });

            expect(failed).toEqual({ sent: false, reason: "send-failed" });

            // The allowance was given back, so the retry can actually send.
            expect(await claimAutoReply(db, email, 1)).toBe(true);
        });

        it("keeps the allowance spent when the mail went out but could not be recorded", async () => {
            const { email } = await nextCustomer();
            const message = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [message] });

            const opened = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("the first message was not filed");
            }

            /**
             * The send succeeds and only the record of it fails — the one
             * case where giving the allowance back would be wrong, because
             * the customer already has the mail and the next message would
             * spend that allowance on a second copy.
             */
            const recordBroken = new Proxy(db, {
                get(target, property) {
                    const value = Reflect.get(target, property, target);

                    // The recording is one transaction — the message and
                    // its audit row together — so breaking that breaks the
                    // record and nothing else.
                    if (property === "transaction") {
                        return () => {
                            throw new Error("could not record the mail");
                        };
                    }

                    return typeof value === "function"
                        ? value.bind(target)
                        : value;
                },
            }) as TestDb;

            const result = await sendTicketConfirmation(recordBroken, channel, {
                ticketId: opened.ticketId,
                limitPerHour: 1,
            });

            // It really did go out, and the caller is told so.
            expect(result).toEqual({ sent: true, reason: "not-recorded" });
            expect(channel.sent).toHaveLength(1);

            // And the allowance stays spent, so no second copy follows.
            expect(await claimAutoReply(db, email, 1)).toBe(false);
        });
    });

    it("leaves no bytes behind when storing an attachment fails part-way", async () => {
        /**
         * A throw in here never reaches a transaction, so the caller's
         * `removeOrphans` never runs: the first attachment was written,
         * pointed at by nothing, and the exception went straight past the
         * only code that knows how to clean up.
         */
        const { email } = await nextCustomer();
        const message = inboundMessage({
            from: { email },
            subject: "Zwei Anhänge",
            hasAttachments: true,
            attachments: [
                {
                    id: "att-ok",
                    filename: "erste.txt",
                    contentType: "text/plain",
                    sizeBytes: 5,
                    isInline: false,
                    contentId: null,
                },
                {
                    id: "att-unstorable",
                    filename: "zweite.txt",
                    contentType: "text/plain",
                    sizeBytes: 5,
                    isInline: false,
                    contentId: null,
                },
            ],
        });

        const channel = fakeChannel({
            messages: [message],
            attachments: {
                "att-ok": Buffer.from("eins"),
                "att-unstorable": Buffer.from("zwei"),
            },
        });

        // Files, not directories: `removeOrphans` takes the bytes away and
        // may leave the ticket's empty folder, which costs nothing.
        const files = async () =>
            (
                await readdir(path.join(storageRoot, "tickets"), {
                    recursive: true,
                    withFileTypes: true,
                }).catch(() => [])
            )
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name)
                .sort();

        const before = await files();

        // The store refuses the second one, after the first is on disk.
        const real = documentStorage();
        let puts = 0;

        setDocumentStorage({
            ...real,
            put: async (...args: Parameters<typeof real.put>) => {
                puts += 1;

                if (puts === 2) {
                    throw new Error("the disk said no");
                }

                return real.put(...args);
            },
        });

        try {
            await expect(
                processInboundMessage(
                    db,
                    options(channel, message.channelMessageId),
                ),
            ).rejects.toThrow(/the disk said no/);
        } finally {
            setDocumentStorage(localStorage(storageRoot));
        }

        // Both attachments were attempted, and nothing is left on disk.
        expect(puts).toBe(2);

        expect(await files()).toEqual(before);
    });

    it("files the message when an attachment cannot be fetched at all", async () => {
        /**
         * Graph answers `$value` with 405 for an item attachment and for a
         * OneDrive reference, and 405 is not `gone`. That used to come out
         * of the pipeline as a throw — the message never became a ticket,
         * and now that the delta cursor waits for a message that failed, the
         * whole mailbox would stop behind one forwarded calendar invitation.
         */
        const { email } = await nextCustomer();
        const message = inboundMessage({
            from: { email },
            subject: "Mit Termin im Anhang",
            hasAttachments: true,
            attachments: [
                {
                    id: "att-item",
                    filename: "Termin.ics",
                    contentType: "application/octet-stream",
                    sizeBytes: 400,
                    isInline: false,
                    contentId: null,
                },
            ],
        });

        const channel = fakeChannel({ messages: [message] });

        channel.downloadAttachment = async () => {
            throw Object.assign(new Error("Graph said 405"), { status: 405 });
        };

        const result = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        if (result.kind !== "filed") {
            throw new Error(`the message was ${result.kind}`);
        }

        expect(result.skippedAttachments).toEqual([
            {
                skipped: true,
                filename: "Termin.ics",
                sizeBytes: 400,
                reason: "unreadable",
            },
        ]);

        // The message itself is all there, which is the point.
        const [row] = await db
            .select()
            .from(schema.ticketMessage)
            .where(eq(schema.ticketMessage.id, result.ticketMessageId));

        expect(row.subject).toBe("Mit Termin im Anhang");

        const kept = await db
            .select()
            .from(schema.ticketAttachment)
            .where(
                eq(schema.ticketAttachment.messageId, result.ticketMessageId),
            );

        expect(kept).toEqual([]);
    });

    it("leaves no empty ticket behind when the mail is already filed elsewhere", async () => {
        /**
         * One mail, two of our mailboxes on it — a customer who copies
         * support@ and abuse@. The claim is per mailbox, so the second one
         * does its own pass; the unique index on `internet_message_id` then
         * refuses the message. What must not happen is the ticket the second
         * pass opened a moment earlier being committed anyway: a numbered,
         * empty ghost in the queue that somebody has to open to find out
         * there is nothing in it.
         */
        const second = "abuse@example.test";

        await makeDepartment(db, { mailbox: second, isDefault: false });

        const { email } = await nextCustomer();
        const message = inboundMessage({
            from: { email },
            subject: "An zwei Postfächer",
        });
        const channel = fakeChannel({ messages: [message] });

        const first = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        if (first.kind !== "filed") {
            throw new Error(`the first pass was ${first.kind}`);
        }

        const before = await db.select().from(schema.ticket);

        /**
         * The second mailbox holds its own copy: a provider id of its own,
         * a conversation of its own, and the sender's one Message-ID — which
         * is exactly why that is the key the pipeline files on.
         */
        const copy = inboundMessage({
            channelMessageId: "AAMk-kopie",
            internetMessageId: message.internetMessageId,
            from: { email },
            subject: "An zwei Postfächer",
            conversationId: "konversation-im-zweiten-postfach",
            to: [{ email: second, name: "Abuse" }],
        });

        channel.add(copy);

        const again = await processInboundMessage(db, {
            ...options(channel, copy.channelMessageId),
            mailbox: second,
        });

        // It is recognised as already filed, and told where.
        expect(again).toEqual({
            kind: "duplicate",
            ticketId: first.ticketId,
        });

        const after = await db.select().from(schema.ticket);

        // Not one new ticket — said as the set, because the damage is a row
        // that exists rather than a count that moved.
        expect(after.map((row) => row.id).sort()).toEqual(
            before.map((row) => row.id).sort(),
        );

        // And the message is still filed exactly once, where it belongs.
        const filed = await db
            .select({ ticketId: schema.ticketMessage.ticketId })
            .from(schema.ticketMessage)
            .where(
                eq(
                    schema.ticketMessage.internetMessageId,
                    message.internetMessageId ?? "",
                ),
            );

        expect(filed).toEqual([{ ticketId: first.ticketId }]);
    });

    it("leaves the claim open when there is no department for the mailbox", async () => {
        const message = inboundMessage({
            from: { email: "wer@example.org" },
        });
        const channel = fakeChannel({ messages: [message] });

        const result = await processInboundMessage(db, {
            ...options(channel, message.channelMessageId),
            mailbox: "unbekannt@example.test",
        });

        expect(result).toEqual({ kind: "no-department" });

        const [row] = await db
            .select()
            .from(schema.inboundMail)
            .where(
                and(
                    eq(schema.inboundMail.mailbox, "unbekannt@example.test"),
                    eq(
                        schema.inboundMail.internetMessageId,
                        message.internetMessageId ?? "",
                    ),
                ),
            );

        // Unhandled on purpose: creating the department is what should make
        // the next pass pick this up, not a row saying it was dealt with.
        expect(row.handledAt).toBeNull();
    });

    it("gives a message with no Message-ID a stable identity of its own", async () => {
        const { email } = await nextCustomer();
        const message = inboundMessage({
            from: { email },
            internetMessageId: null,
        });
        const channel = fakeChannel({ messages: [message] });

        const first = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        expect(first.kind).toBe("filed");

        const synthetic = syntheticMessageId({
            mailbox: MAILBOX,
            from: email,
            subject: message.subject,
            receivedAt: message.receivedAt,
            body: message.bodyHtml ?? message.bodyText,
        });

        const [row] = await db
            .select()
            .from(schema.inboundMail)
            .where(eq(schema.inboundMail.internetMessageId, synthetic));

        expect(row).toBeDefined();

        // Re-delivered under its new provider id: still the same message.
        expect(
            await processInboundMessage(
                db,
                options(channel, `${message.channelMessageId}-moved`),
            ),
        ).toMatchObject({ kind: "duplicate" });
    });

    it("tells two Message-ID-less messages of the same second apart", async () => {
        /**
         * Graph reports `receivedDateTime` to the second, and the things
         * that send mail without a Message-ID are exactly the things that
         * send the same subject from the same address twice in a row — a web
         * form submitted twice, a script firing on two checks. On mailbox,
         * sender, subject and second alone those two are one message, and the
         * second one is filed nowhere, moved out of the inbox and never seen.
         */
        const { email } = await nextCustomer();
        const shared = {
            from: { email },
            internetMessageId: null,
            subject: "Kontaktformular",
            receivedAt: new Date("2026-11-08T11:00:00.000Z"),
        };

        const one = inboundMessage({
            ...shared,
            channelMessageId: "AAMk-form-1",
            bodyHtml: "<div>Bitte rufen Sie mich an.</div>",
        });
        const two = inboundMessage({
            ...shared,
            channelMessageId: "AAMk-form-2",
            bodyHtml: "<div>Und meine Rechnung stimmt auch nicht.</div>",
        });

        const channel = fakeChannel({ messages: [one, two] });

        const first = await processInboundMessage(
            db,
            options(channel, one.channelMessageId),
        );
        const second = await processInboundMessage(
            db,
            options(channel, two.channelMessageId),
        );

        if (first.kind !== "filed" || second.kind !== "filed") {
            throw new Error(
                `the two submissions were ${first.kind} and ${second.kind}`,
            );
        }

        // Both are in the database, and both say what their sender wrote.
        const rows = await db
            .select({ text: schema.ticketMessage.displayText })
            .from(schema.ticketMessage)
            .where(
                inArray(schema.ticketMessage.id, [
                    first.ticketMessageId,
                    second.ticketMessageId,
                ]),
            );

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.text).sort()).toEqual([
            "Bitte rufen Sie mich an.",
            "Und meine Rechnung stimmt auch nicht.",
        ]);
    });

    it("reprocesses a message whose claim an operator reopened", async () => {
        const { email } = await nextCustomer();
        const message = inboundMessage({ from: { email } });
        const channel = fakeChannel({ messages: [message] });

        const first = await processInboundMessage(
            db,
            options(channel, message.channelMessageId),
        );

        if (first.kind !== "filed") {
            throw new Error("not filed");
        }

        const [row] = await db
            .select()
            .from(schema.inboundMail)
            .where(
                eq(
                    schema.inboundMail.internetMessageId,
                    message.internetMessageId ?? "",
                ),
            );

        expect(await reopenInboundMail(db, row.id)).toBe(true);

        const [reopened] = await db
            .select()
            .from(schema.inboundMail)
            .where(eq(schema.inboundMail.id, row.id));

        expect(reopened.handledAt).toBeNull();
        expect(reopened.outcome).toBeNull();

        /**
         * And the work is actually queued. Clearing the claim on its own put
         * the row in a state nothing reads: the cursor had moved past the
         * message and it was sitting in the processed folder, so "wird beim
         * nächsten Abholen erneut verarbeitet" was not true of it.
         */
        const [queued] = await db
            .select()
            .from(schema.mailNotification)
            .where(
                eq(
                    schema.mailNotification.resourceId,
                    reopened.channelMessageId ?? "",
                ),
            );

        expect(queued).toBeDefined();
        expect(queued.handledAt).toBeNull();
        expect(queued.mailbox).toBe(reopened.mailbox);
        expect(queued.changeType).toBe("reprocess");

        expect(await reopenInboundMail(db, createId("inboundmail"))).toBe(
            false,
        );
    });

    describe("merging", () => {
        it("moves the messages and brings exactly them back", async () => {
            const { email } = await nextCustomer();
            const a = inboundMessage({ from: { email }, subject: "Teil eins" });
            const b = inboundMessage({ from: { email }, subject: "Teil zwei" });
            const channel = fakeChannel({ messages: [a, b] });

            const first = await processInboundMessage(
                db,
                options(channel, a.channelMessageId),
            );
            const second = await processInboundMessage(
                db,
                options(channel, b.channelMessageId),
            );

            if (first.kind !== "filed" || second.kind !== "filed") {
                throw new Error("both messages should have been filed");
            }

            await mergeTickets(
                db,
                { sourceId: second.ticketId, targetId: first.ticketId },
                { type: "system", label: "test" },
            );

            const [source] = await db
                .select()
                .from(schema.ticket)
                .where(eq(schema.ticket.id, second.ticketId));

            expect(source.mergedIntoTicketId).toBe(first.ticketId);
            expect(source.status).toBe("closed");

            const moved = await db
                .select()
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.ticketId, first.ticketId));

            expect(moved).toHaveLength(2);

            // A reply carrying the *source* ticket's number still resolves —
            // to the target, which is the whole point of merging rather than
            // deleting.
            const tag = `TKT-${String(second.ticketNumber).padStart(5, "0")}`;
            const reply = inboundMessage({
                from: { email },
                subject: `AW: [${tag}] Teil zwei`,
                headers: {},
                conversationId: "egal",
            });

            channel.add(reply);

            expect(
                await processInboundMessage(
                    db,
                    options(channel, reply.channelMessageId),
                ),
            ).toMatchObject({
                ticketId: first.ticketId,
                matchedBy: "subject-tag",
            });

            // A message that arrived at the target *after* the merge must
            // not travel back with the unmerge.
            await unmergeTicket(db, second.ticketId, {
                type: "system",
                label: "test",
            });

            const back = await db
                .select()
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.ticketId, second.ticketId));

            expect(back).toHaveLength(1);
            expect(back[0].mergedFromTicketId).toBeNull();

            const kept = await db
                .select()
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.ticketId, first.ticketId));

            expect(kept).toHaveLength(2);
        });

        it("refuses a merge onto a ticket that was itself merged away", async () => {
            const { email } = await nextCustomer();
            const a = inboundMessage({ from: { email } });
            const b = inboundMessage({ from: { email } });
            const c = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [a, b, c] });

            const ids: string[] = [];

            for (const message of [a, b, c]) {
                const result = await processInboundMessage(
                    db,
                    options(channel, message.channelMessageId),
                );

                if (result.kind !== "filed") {
                    throw new Error("not filed");
                }

                ids.push(result.ticketId);
            }

            await mergeTickets(
                db,
                { sourceId: ids[0], targetId: ids[1] },
                { type: "system", label: "test" },
            );

            await expect(
                mergeTickets(
                    db,
                    { sourceId: ids[2], targetId: ids[0] },
                    { type: "system", label: "test" },
                ),
            ).rejects.toThrow(/selbst zusammengeführt/);
        });

        it("refuses to move one customer's messages into another's ticket", async () => {
            /**
             * A merge moves every message of the source onto the target, and
             * the target's customer reads the target in the portal. The
             * picker is a list of ticket numbers, so one wrong click would
             * otherwise hand a stranger the whole correspondence.
             */
            const mine = await nextCustomer();
            const theirs = await nextCustomer();

            const a = inboundMessage({ from: { email: mine.email } });
            const b = inboundMessage({ from: { email: theirs.email } });
            const channel = fakeChannel({ messages: [a, b] });

            const first = await processInboundMessage(
                db,
                options(channel, a.channelMessageId),
            );
            const second = await processInboundMessage(
                db,
                options(channel, b.channelMessageId),
            );

            if (first.kind !== "filed" || second.kind !== "filed") {
                throw new Error("both messages should have been filed");
            }

            await expect(
                mergeTickets(
                    db,
                    { sourceId: second.ticketId, targetId: first.ticketId },
                    { type: "system", label: "test" },
                ),
            ).rejects.toThrow(/verschiedenen Kunden/);

            // And nothing moved: the refusal is before the first write.
            const stayed = await db
                .select({ id: schema.ticketMessage.id })
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.ticketId, second.ticketId));

            expect(stayed).toHaveLength(1);
        });

        it("lets an unowned ticket be merged onto a customer's, but not the other way", async () => {
            const { email } = await nextCustomer();
            const owned = inboundMessage({ from: { email } });
            const stranger = inboundMessage({
                from: { email: "fremder@example.org" },
            });
            const channel = fakeChannel({ messages: [owned, stranger] });

            const mine = await processInboundMessage(
                db,
                options(channel, owned.channelMessageId),
            );
            const unowned = await processInboundMessage(
                db,
                options(channel, stranger.channelMessageId),
            );

            if (mine.kind !== "filed" || unowned.kind !== "filed") {
                throw new Error("both messages should have been filed");
            }

            // The wrong way round is refused and says which way to go.
            await expect(
                mergeTickets(
                    db,
                    { sourceId: mine.ticketId, targetId: unowned.ticketId },
                    { type: "system", label: "test" },
                ),
            ).rejects.toThrow(/andere Richtung/);

            // The direction that is the point of merging is allowed.
            await mergeTickets(
                db,
                { sourceId: unowned.ticketId, targetId: mine.ticketId },
                { type: "system", label: "test" },
            );

            const moved = await db
                .select({ id: schema.ticketMessage.id })
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.ticketId, mine.ticketId));

            expect(moved).toHaveLength(2);
        });

        it("keeps the first merge's provenance when the target is merged on", async () => {
            /**
             * C into B, then B into A. Rewriting C's marker to B is how
             * unmerging C used to hand back an empty ticket while its
             * messages stayed in A for ever.
             */
            const { email } = await nextCustomer();
            const messages = [
                inboundMessage({ from: { email }, subject: "A" }),
                inboundMessage({ from: { email }, subject: "B" }),
                inboundMessage({ from: { email }, subject: "C" }),
            ];
            const channel = fakeChannel({ messages });
            const ids: string[] = [];

            for (const message of messages) {
                const filed = await processInboundMessage(
                    db,
                    options(channel, message.channelMessageId),
                );

                if (filed.kind !== "filed") {
                    throw new Error("not filed");
                }

                ids.push(filed.ticketId);
            }

            const [a, b, c] = ids;

            await mergeTickets(
                db,
                { sourceId: c, targetId: b },
                { type: "system", label: "test" },
            );
            await mergeTickets(
                db,
                { sourceId: b, targetId: a },
                { type: "system", label: "test" },
            );

            await unmergeTicket(db, c, { type: "system", label: "test" });

            const back = await db
                .select({ subject: schema.ticketMessage.subject })
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.ticketId, c));

            expect(back.map((row) => row.subject)).toEqual(["C"]);

            // And B's own message is still where the second merge put it.
            const inA = await db
                .select({ subject: schema.ticketMessage.subject })
                .from(schema.ticketMessage)
                .where(eq(schema.ticketMessage.ticketId, a));

            expect(inA.map((row) => row.subject).sort()).toEqual(["A", "B"]);
        });
    });

    describe("who a reply goes to", () => {
        it("is the requester and the account's own contacts, and nobody else", async () => {
            const { customerId, email } = await nextCustomer();
            const first = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [first] });

            const opened = await processInboundMessage(
                db,
                options(channel, first.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("not filed");
            }

            // A second contact on the same account writes in: a recipient.
            const [colleague] = await db
                .insert(schema.user)
                .values({
                    name: "Kollege",
                    email: `kollege-${customerId.slice(-6).toLowerCase()}@example.test`,
                    emailVerified: true,
                })
                .returning();

            await db.insert(schema.customerContact).values({
                customerId,
                userId: colleague.id,
                role: "contact",
                email: colleague.email,
            });

            const tag = `TKT-${String(opened.ticketNumber).padStart(5, "0")}`;

            for (const sender of [colleague.email, "fremd@example.org"]) {
                const message = inboundMessage({
                    from: { email: sender },
                    subject: `AW: [${tag}] dazu`,
                    headers: {},
                });

                channel.add(message);

                await processInboundMessage(
                    db,
                    options(channel, message.channelMessageId),
                );
            }

            const [ticket] = await db
                .select()
                .from(schema.ticket)
                .where(eq(schema.ticket.id, opened.ticketId));

            const recipients = (await replyRecipients(db, ticket)).map(
                (entry) => entry.email,
            );

            expect(recipients).toContain(email);
            // Lower-cased: every address in this system is compared in one
            // case, because nothing about a local part is in practice.
            expect(recipients).toContain(colleague.email.toLowerCase());
            /**
             * The stray sender knew the ticket number — which travels on a
             * subject line and is therefore guessable — and is **not** a
             * recipient. A reply that went back to them would turn a number
             * into a way of reading somebody else's support history.
             */
            expect(recipients).not.toContain("fremd@example.org");

            // And the ticket is flagged, so staff see it before replying.
            expect(ticket.unknownSender).toBe(true);
        });

        it("is only the requester while the ticket has no account", async () => {
            const message = inboundMessage({
                from: { email: "niemand@example.org" },
            });
            const channel = fakeChannel({ messages: [message] });

            const opened = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("not filed");
            }

            const [ticket] = await db
                .select()
                .from(schema.ticket)
                .where(eq(schema.ticket.id, opened.ticketId));

            expect(await replyRecipients(db, ticket)).toEqual([
                { email: "niemand@example.org", name: null },
            ]);
        });

        it("sends to exactly those, and quotes the last message back", async () => {
            const { email } = await nextCustomer();
            const message = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [message] });

            const opened = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("not filed");
            }

            const result = await replyToTicket(
                db,
                channel,
                {
                    ticketId: opened.ticketId,
                    body: "Wir sehen nach.",
                    // A CC the operator typed, and one that is nonsense.
                    cc: ["kopie@example.org", "kein-komma"],
                },
                { type: "system", label: "test" },
            );

            expect(result.recipients).toEqual([email]);

            const sent = channel.sent.at(-1);

            expect(sent?.message.to.map((entry) => entry.email)).toEqual([
                email,
            ]);
            expect(sent?.message.cc?.map((entry) => entry.email)).toEqual([
                "kopie@example.org",
            ]);
            expect(sent?.message.subject).toContain(
                `TKT-${String(opened.ticketNumber).padStart(5, "0")}`,
            );
            // Replied in place, so the provider keeps the thread together.
            expect(sent?.message.replyToChannelMessageId).toBe(
                `${message.channelMessageId}-moved`,
            );
            // Our own quote marker, so a client we have never seen still
            // produces a strippable history on the way back.
            expect(sent?.message.html).toContain("data-virtify-quote");

            const [ticket] = await db
                .select()
                .from(schema.ticket)
                .where(eq(schema.ticket.id, opened.ticketId));

            expect(ticket.status).toBe("waiting");
            expect(ticket.firstResponseAt).not.toBeNull();
        });

        it("refuses to answer in a ticket that was merged away", async () => {
            const { email } = await nextCustomer();
            const a = inboundMessage({ from: { email } });
            const b = inboundMessage({ from: { email } });
            const channel = fakeChannel({ messages: [a, b] });

            const source = await processInboundMessage(
                db,
                options(channel, a.channelMessageId),
            );
            const target = await processInboundMessage(
                db,
                options(channel, b.channelMessageId),
            );

            if (source.kind !== "filed" || target.kind !== "filed") {
                throw new Error("not filed");
            }

            await mergeTickets(
                db,
                { sourceId: source.ticketId, targetId: target.ticketId },
                { type: "system", label: "test" },
            );

            await expect(
                replyToTicket(
                    db,
                    channel,
                    { ticketId: source.ticketId, body: "x" },
                    { type: "system", label: "test" },
                ),
            ).rejects.toThrow(/zusammengeführt/);
        });
    });

    describe("who may fetch an attachment", () => {
        it("is the ticket's own account and staff, and not an internal note", async () => {
            const { customerId, email } = await nextCustomer();
            const other = await nextCustomer();
            const message = inboundMessage({
                from: { email },
                hasAttachments: true,
                attachments: [
                    {
                        id: "att-scope",
                        filename: "rechnung.pdf",
                        contentType: "application/pdf",
                        sizeBytes: 4,
                        isInline: false,
                        contentId: null,
                    },
                ],
            });

            const channel = fakeChannel({
                messages: [message],
                attachments: { "att-scope": Buffer.from("abcd") },
            });

            const opened = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("not filed");
            }

            const [attachment] = await db
                .select()
                .from(schema.ticketAttachment)
                .where(
                    eq(
                        schema.ticketAttachment.messageId,
                        opened.ticketMessageId,
                    ),
                );

            expect(await attachmentInScope(attachment.id, customerId, db)).toBe(
                true,
            );
            expect(
                await attachmentInScope(attachment.id, other.customerId, db),
            ).toBe(false);
            expect(
                await attachmentInScope(attachment.id, ANY_CUSTOMER, db),
            ).toBe(true);

            // Something hanging off an internal note is staff-only, whoever
            // the ticket belongs to.
            const noteId = await addInternalNote(
                db,
                { ticketId: opened.ticketId, body: "intern" },
                { type: "system", label: "test" },
            );

            const [noteAttachment] = await db
                .insert(schema.ticketAttachment)
                .values({
                    messageId: noteId,
                    filename: "intern.txt",
                    contentType: "text/plain",
                    sizeBytes: 1,
                    storageKey: `tickets/${opened.ticketId}/intern.txt`,
                    sha256: "x",
                })
                .returning();

            expect(
                await attachmentInScope(noteAttachment.id, customerId, db),
            ).toBe(false);
            expect(
                await attachmentInScope(noteAttachment.id, ANY_CUSTOMER, db),
            ).toBe(true);
        });

        it("removes the row and the bytes together", async () => {
            const { email } = await nextCustomer();
            const message = inboundMessage({
                from: { email },
                hasAttachments: true,
                attachments: [
                    {
                        id: "att-delete",
                        filename: "weg.txt",
                        contentType: "text/plain",
                        sizeBytes: 3,
                        isInline: false,
                        contentId: null,
                    },
                ],
            });

            const channel = fakeChannel({
                messages: [message],
                attachments: { "att-delete": Buffer.from("weg") },
            });

            const opened = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            if (opened.kind !== "filed") {
                throw new Error("not filed");
            }

            const [attachment] = await db
                .select()
                .from(schema.ticketAttachment)
                .where(
                    eq(
                        schema.ticketAttachment.messageId,
                        opened.ticketMessageId,
                    ),
                );

            expect(await readAttachment(db, attachment.id)).not.toBeNull();
            expect(await deleteAttachment(db, attachment.id)).toBe(true);
            expect(await readAttachment(db, attachment.id)).toBeNull();

            await expect(
                stat(path.join(storageRoot, attachment.storageKey)),
            ).rejects.toThrow();

            // Idempotent: removing one that is already gone is not an error.
            expect(await deleteAttachment(db, attachment.id)).toBe(false);
        });
    });

    it("reconciles a mailbox through the delta query and stores the cursor", async () => {
        const { email } = await nextCustomer();
        const message = inboundMessage({ from: { email } });
        const channel = fakeChannel({
            messages: [message],
            deltaIds: [message.channelMessageId],
        });

        const report = await reconcileMailbox(
            db,
            {
                channel,
                config: {
                    ...DEFAULT_MAIL_CHANNEL,
                    id: "msgraph" as const,
                    label: "Graph",
                    enabled: true,
                },
            },
            MAILBOX,
        );

        expect(report.delta).toEqual([
            { mailbox: MAILBOX, fetched: 1, deltaAdvanced: true },
        ]);
        expect(report.results["filed:new"]).toBe(1);

        const [state] = await db
            .select()
            .from(schema.mailboxState)
            .where(eq(schema.mailboxState.mailbox, MAILBOX));

        expect(state.deltaLink).toBe("https://graph.invalid/delta?token=next");
    });

    it("does not move the cursor past a message whose pass threw", async () => {
        /**
         * The message that throws is almost always the one that was never
         * claimed — the fetch is the first thing the pipeline does and the
         * claim is the second — and Graph never reports a message twice for
         * the same token. Advancing here is a mail gone, not a retry
         * postponed, so the cursor waits.
         */
        const third = "cursor@example.test";

        await makeDepartment(db, { mailbox: third, isDefault: false });

        const { email } = await nextCustomer();
        const good = inboundMessage({
            from: { email },
            subject: "geht durch",
        });
        const broken = inboundMessage({
            from: { email },
            subject: "geht nicht durch",
        });

        const channel = fakeChannel({
            messages: [good, broken],
            deltaIds: [good.channelMessageId, broken.channelMessageId],
            failOn: {
                [broken.channelMessageId]: new Error("Graph said 500"),
            },
        });

        const config = {
            ...DEFAULT_MAIL_CHANNEL,
            id: "msgraph" as const,
            label: "Graph",
            enabled: true,
        };

        const report = await reconcileMailbox(db, { channel, config }, third);

        // The good one was filed — the page was not abandoned wholesale.
        expect(report.results["filed:new"]).toBe(1);
        expect(report.failures).toHaveLength(1);
        expect(report.failures[0].detail).toContain("Graph said 500");

        // And the cursor stayed where it was, which the report also says.
        expect(report.delta).toEqual([
            { mailbox: third, fetched: 2, deltaAdvanced: false },
        ]);

        const [state] = await db
            .select()
            .from(schema.mailboxState)
            .where(eq(schema.mailboxState.mailbox, third));

        expect(state).toBeUndefined();
    });

    it("clears a delta link Graph no longer accepts, so the mailbox is reconciled again", async () => {
        const channel = fakeChannel();

        channel.listDelta = async () => {
            throw Object.assign(new Error("delta token expired"), {
                status: 410,
            });
        };

        const config = {
            ...DEFAULT_MAIL_CHANNEL,
            id: "msgraph" as const,
            label: "Graph",
            enabled: true,
        };

        const report = await reconcileMailbox(db, { channel, config }, MAILBOX);

        expect(report.failures).toHaveLength(1);
        expect(report.failures[0].stage).toBe(`delta:${MAILBOX}`);

        const [state] = await db
            .select()
            .from(schema.mailboxState)
            .where(eq(schema.mailboxState.mailbox, MAILBOX));

        /**
         * Cleared, not kept. Keeping a token Graph has forgotten means the
         * mailbox is never reconciled again — which is the quiet failure
         * the delta query exists to prevent in the first place.
         */
        expect(state.deltaLink).toBeNull();
    });

    it("does not advance the cursor when the channel gave no new one", async () => {
        const { email } = await nextCustomer();
        const message = inboundMessage({ from: { email } });
        const channel = fakeChannel({ messages: [message] });

        await db
            .insert(schema.mailboxState)
            .values({ mailbox: MAILBOX, deltaLink: "alt" })
            .onConflictDoUpdate({
                target: schema.mailboxState.mailbox,
                set: { deltaLink: "alt" },
            });

        channel.listDelta = async () => ({
            messageIds: [message.channelMessageId],
            deltaLink: null,
        });

        const report = await reconcileMailbox(
            db,
            {
                channel,
                config: {
                    ...DEFAULT_MAIL_CHANNEL,
                    id: "msgraph" as const,
                    label: "Graph",
                    enabled: true,
                },
            },
            MAILBOX,
        );

        expect(report.delta[0].deltaAdvanced).toBe(false);

        const [state] = await db
            .select()
            .from(schema.mailboxState)
            .where(eq(schema.mailboxState.mailbox, MAILBOX));

        expect(state.deltaLink).toBe("alt");
    });
});
