import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@/lib/ulid";
import { localStorage, setDocumentStorage } from "@/server/storage";
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
                return;
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
                from: { email: "chef@example.org" },
                headers: { "x-auto-response-suppress": "All" },
            });
            const channel = fakeChannel({ messages: [message] });

            const result = await processInboundMessage(
                db,
                options(channel, message.channelMessageId),
            );

            expect(result).toEqual({
                kind: "ignored",
                reason: "auto-response-suppressed",
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
            expect(row.reason).toBe("auto-response-suppressed");
            expect(row.handledAt).not.toBeNull();
            expect(row.ticketId).toBeNull();

            // Still moved: a message left in the inbox is one the next delta
            // pass picks up for ever.
            expect(channel.moved).toHaveLength(1);
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
                return;
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
