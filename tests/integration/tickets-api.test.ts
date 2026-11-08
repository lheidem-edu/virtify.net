import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * `/api/v1/tickets` end to end: the real route handlers, the real bearer
 * middleware, the real transactions.
 *
 * Two claims run through all of it. **A key is never more than its owner**
 * (rule 5): a customer key that names somebody else's ticket gets 404, not
 * 403, because 403 would confirm the id exists — and a ticket number is
 * short and guessable, which makes that worse here than anywhere else.
 * **An internal note never leaves the building**, not even for a staff key,
 * because it is a thing somebody wrote in the knowledge that it stays
 * inside.
 *
 * The handlers reach for `@/db` rather than taking an executor — a request
 * has no transaction to hand them — so this file points that module at the
 * throwaway database before importing them, which is why everything is a
 * dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("/api/v1/tickets", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    type Handler = (request: Request) => Promise<Response>;
    type ItemHandler = (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;

    let list: Handler;
    let create: Handler;
    let read: ItemHandler;
    let reply: ItemHandler;

    const staffUserId = "staffuser_01MTESTTICKETSAAAAAAAAAA";

    let staffToken = "";
    let readOnlyToken = "";
    let customerToken = "";
    let otherCustomerToken = "";

    let customerId = "";
    let otherCustomerId = "";
    let ticketId = "";
    let noteId = "";
    let orphanTicketId = "";

    const bearer = (
        token: string,
        url: string,
        body?: unknown,
        method = body === undefined ? "GET" : "POST",
    ) =>
        new Request(url, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                ...(body === undefined
                    ? {}
                    : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        list = (await import("@/app/api/v1/tickets/route")).GET;
        create = (await import("@/app/api/v1/tickets/route")).POST;
        read = (await import("@/app/api/v1/tickets/[id]/route")).GET;
        reply = (await import("@/app/api/v1/tickets/[id]/messages/route")).POST;

        const { createApiKey } = await import("@/server/api-keys");
        const { createCustomer } = await import(
            "@/server/customers/repository"
        );
        const { createTicket, addInternalNote } = await import(
            "@/server/tickets/service"
        );

        const system = { type: "system" as const };

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Verwaltung",
            email: "tickets@example.test",
            emailVerified: true,
        });

        const [role] = await db
            .insert(schema.staffRole)
            .values({ name: "Alles", permissions: ["*"] })
            .returning();

        await db
            .insert(schema.staffRoleAssignment)
            .values({ staffUserId, roleId: role.id });

        await db.insert(schema.ticketDepartment).values({
            name: "Support",
            slug: "support",
            mailbox: "support@example.test",
            isDefault: true,
        });

        const first = await createCustomer(
            db,
            {
                kind: "private",
                name: "Maria Musterfrau",
                country: "DE",
                street: "Weg 1",
                postalCode: "12345",
                city: "Ort",
                currency: "EUR",
                language: "de",
                status: "active",
            },
            system,
        );

        const second = await createCustomer(
            db,
            {
                kind: "private",
                name: "Jemand Anders",
                country: "DE",
                street: "Weg 2",
                postalCode: "12345",
                city: "Ort",
                currency: "EUR",
                language: "de",
                status: "active",
            },
            system,
        );

        customerId = first.id;
        otherCustomerId = second.id;

        for (const [customer, email] of [
            [customerId, "maria@example.test"],
            [otherCustomerId, "anders@example.test"],
        ] as const) {
            const [user] = await db
                .insert(schema.user)
                .values({ name: email, email, emailVerified: true })
                .returning();

            await db.insert(schema.customerContact).values({
                customerId: customer,
                userId: user.id,
                role: "owner",
                email,
            });
        }

        const created = await createTicket(
            db,
            {
                customerId,
                subject: "Server nicht erreichbar",
                body: "Seit heute Morgen ist nichts mehr zu erreichen.",
                requesterEmail: "maria@example.test",
            },
            system,
        );

        ticketId = created.ticketId;

        noteId = await addInternalNote(
            db,
            { ticketId, body: "Kunde ruft ständig an." },
            system,
        );

        const orphan = await createTicket(
            db,
            {
                customerId: null,
                subject: "Von irgendwem",
                body: "Hallo?",
                requesterEmail: "fremd@example.org",
            },
            system,
        );

        orphanTicketId = orphan.ticketId;

        staffToken = (
            await createApiKey(
                db,
                {
                    name: "staff",
                    scopes: ["*" as never],
                    owner: { type: "staff", staffUserId },
                },
                system,
            )
        ).token;

        readOnlyToken = (
            await createApiKey(
                db,
                {
                    name: "read only",
                    scopes: ["tickets.read"],
                    owner: { type: "staff", staffUserId },
                },
                system,
            )
        ).token;

        customerToken = (
            await createApiKey(
                db,
                {
                    name: "maria",
                    scopes: ["tickets.read", "tickets.write", "tickets.reply"],
                    owner: { type: "customer", customerId },
                },
                system,
            )
        ).token;

        otherCustomerToken = (
            await createApiKey(
                db,
                {
                    name: "anders",
                    scopes: ["tickets.read", "tickets.write", "tickets.reply"],
                    owner: { type: "customer", customerId: otherCustomerId },
                },
                system,
            )
        ).token;
    });

    afterAll(async () => {
        /**
         * The route handlers reach for `@/db`, which opened a pool of its
         * own against this database. Dropping it out from under that pool
         * is what makes `terminating connection due to administrator
         * command` an unhandled error rather than a tidy shutdown.
         */
        const { db: appDb } = await import("@/db");

        await (
            appDb as unknown as { $client: { end(): Promise<void> } }
        ).$client.end();

        await drop();
    });

    it("refuses a request with no key", async () => {
        const response = await list(
            new Request("https://virtify.test/api/v1/tickets"),
        );

        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toContain(
            "application/problem+json",
        );
    });

    it("shows a customer only their own tickets", async () => {
        const response = await list(
            bearer(customerToken, "https://virtify.test/api/v1/tickets"),
        );

        expect(response.status).toBe(200);

        const body = (await response.json()) as {
            data: { id: string; customer_id: string }[];
        };

        expect(body.data).toHaveLength(1);
        expect(body.data[0].id).toBe(ticketId);
    });

    it("hides a ticket with no account from every customer", async () => {
        for (const token of [customerToken, otherCustomerToken]) {
            const response = await list(
                bearer(token, "https://virtify.test/api/v1/tickets"),
            );

            const body = (await response.json()) as { data: { id: string }[] };

            expect(body.data.some((row) => row.id === orphanTicketId)).toBe(
                false,
            );

            expect(
                (
                    await read(
                        bearer(token, "https://virtify.test/api/v1/tickets/x"),
                        params(orphanTicketId),
                    )
                ).status,
            ).toBe(404);
        }

        // Staff see it, which is the only reason to keep it.
        const staff = await read(
            bearer(staffToken, "https://virtify.test/api/v1/tickets/x"),
            params(orphanTicketId),
        );

        expect(staff.status).toBe(200);
    });

    it("ignores customer_id on a customer key rather than honouring it", async () => {
        const response = await list(
            bearer(
                customerToken,
                `https://virtify.test/api/v1/tickets?customer_id=${otherCustomerId}`,
            ),
        );

        const body = (await response.json()) as {
            data: { id: string }[];
        };

        expect(body.data).toHaveLength(1);
        expect(body.data[0].id).toBe(ticketId);
    });

    it("answers 404, never 403, for another account's ticket", async () => {
        const response = await read(
            bearer(otherCustomerToken, "https://virtify.test/api/v1/tickets/x"),
            params(ticketId),
        );

        expect(response.status).toBe(404);
    });

    it("never serializes an internal note, not even for a staff key", async () => {
        for (const token of [staffToken, customerToken]) {
            const response = await read(
                bearer(token, "https://virtify.test/api/v1/tickets/x"),
                params(ticketId),
            );
            const body = (await response.json()) as {
                messages: { id: string; body: string }[];
            };

            expect(body.messages.some((row) => row.id === noteId)).toBe(false);
            expect(
                body.messages.some((row) =>
                    row.body.includes("ruft ständig an"),
                ),
            ).toBe(false);
        }
    });

    it("leaves a note out even when the loader was asked for one", async () => {
        const { loadTicket, ANY_CUSTOMER } = await import(
            "@/server/tickets/repository"
        );
        const { serializeTicket } = await import("@/server/tickets/api");

        const loaded = await loadTicket(
            ticketId,
            // A dynamic import widens the `unique symbol` to `symbol`.
            ANY_CUSTOMER as Parameters<typeof loadTicket>[1],
            db,
            { includeNotes: true },
        );

        if (!loaded) {
            throw new Error("the ticket should load");
        }

        // The loader did hand them over — this is the second layer, and it
        // is the one a future caller that passes `includeNotes` would hit.
        expect(loaded.messages.some((row) => row.id === noteId)).toBe(true);

        const serialized = serializeTicket(loaded);

        expect(serialized.messages.some((row) => row.id === noteId)).toBe(
            false,
        );
    });

    it("opens a ticket for the key's own account and ignores the address it names", async () => {
        const response = await create(
            bearer(customerToken, "https://virtify.test/api/v1/tickets", {
                customer_id: otherCustomerId,
                requester_email: "angreifer@example.org",
                subject: "Frage",
                message: "Wie geht das?",
            }),
        );

        expect(response.status).toBe(201);

        const body = (await response.json()) as {
            id: string;
            customer_id: string;
            requester_email: string;
            reference: string;
        };

        // Both fields overwritten: a key that could name either could open a
        // ticket in somebody else's name, and the reply would go to the
        // address the ticket learned from it.
        expect(body.customer_id).toBe(customerId);
        expect(body.requester_email).toBe("maria@example.test");
        expect(body.reference).toMatch(/^TKT-\d{5}$/);
    });

    it("refuses a staff key that names neither an account nor an address", async () => {
        const response = await create(
            bearer(staffToken, "https://virtify.test/api/v1/tickets", {
                subject: "Frage",
                message: "Wie geht das?",
            }),
        );

        expect(response.status).toBe(422);
    });

    it("names the field that failed the check", async () => {
        const response = await create(
            bearer(customerToken, "https://virtify.test/api/v1/tickets", {
                subject: "",
                message: "x",
            }),
        );

        expect(response.status).toBe(422);

        const body = (await response.json()) as {
            errors: { path: string }[];
        };

        expect(body.errors.some((entry) => entry.path === "subject")).toBe(
            true,
        );
    });

    it("refuses a key whose scopes do not cover the write", async () => {
        const response = await create(
            bearer(readOnlyToken, "https://virtify.test/api/v1/tickets", {
                customer_id: customerId,
                subject: "Frage",
                message: "x",
            }),
        );

        expect(response.status).toBe(403);
    });

    it("adds a customer's reply without sending anything", async () => {
        const response = await reply(
            bearer(customerToken, "https://virtify.test/api/v1/tickets/x", {
                message: "Noch eine Frage.",
            }),
            params(ticketId),
        );

        expect(response.status).toBe(201);

        const rows = await db
            .select()
            .from(schema.ticketMessage)
            .where(eq(schema.ticketMessage.ticketId, ticketId));

        const added = rows.find((row) =>
            row.displayText.includes("Noch eine Frage"),
        );

        expect(added?.direction).toBe("inbound");
        // Nothing left the building: no outbound row, no Message-ID.
        expect(added?.internetMessageId).toBeNull();
    });

    it("answers 404 when a customer key replies to somebody else's ticket", async () => {
        const response = await reply(
            bearer(
                otherCustomerToken,
                "https://virtify.test/api/v1/tickets/x",
                { message: "Hallo" },
            ),
            params(ticketId),
        );

        expect(response.status).toBe(404);

        const rows = await db
            .select()
            .from(schema.ticketMessage)
            .where(eq(schema.ticketMessage.ticketId, ticketId));

        expect(rows.some((row) => row.displayText === "Hallo")).toBe(false);
    });

    it("refuses a staff reply with 503 when no mailbox is connected", async () => {
        const response = await reply(
            bearer(staffToken, "https://virtify.test/api/v1/tickets/x", {
                message: "Wir schauen nach.",
            }),
            params(ticketId),
        );

        // Refused rather than recorded as sent: a reply the customer never
        // receives is worse than one that was not accepted.
        expect(response.status).toBe(503);

        const rows = await db
            .select()
            .from(schema.ticketMessage)
            .where(eq(schema.ticketMessage.ticketId, ticketId));

        expect(rows.some((row) => row.direction === "outbound")).toBe(false);
    });

    it("paginates by cursor without repeating or skipping", async () => {
        const { createTicket } = await import("@/server/tickets/service");

        for (let i = 0; i < 5; i += 1) {
            await createTicket(
                db,
                {
                    customerId,
                    subject: `Seite ${i}`,
                    body: "x",
                    requesterEmail: "maria@example.test",
                },
                { type: "system" },
            );
        }

        const seen: string[] = [];
        let cursor: string | null = null;

        for (let page = 0; page < 10; page += 1) {
            const url = new URL("https://virtify.test/api/v1/tickets");

            url.searchParams.set("limit", "2");

            if (cursor) {
                url.searchParams.set("cursor", cursor);
            }

            const response = await list(bearer(customerToken, url.toString()));
            const body = (await response.json()) as {
                data: { id: string }[];
                next_cursor: string | null;
                has_more: boolean;
            };

            seen.push(...body.data.map((row) => row.id));
            cursor = body.next_cursor;

            if (!body.has_more) {
                break;
            }
        }

        expect(new Set(seen).size).toBe(seen.length);

        const all = await db
            .select({ id: schema.ticket.id })
            .from(schema.ticket)
            .where(eq(schema.ticket.customerId, customerId));

        expect(seen.length).toBe(all.length);
    });
});
