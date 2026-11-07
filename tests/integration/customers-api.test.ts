import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * `/api/v1/customers` end to end: the real route handlers, the real bearer
 * middleware, the real queries.
 *
 * The handlers reach for `@/db` rather than taking an executor — they are
 * route handlers, and a request has no transaction to hand them — so this
 * file points that module at the throwaway database before importing them.
 * That is why everything here is a dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("GET/POST/PATCH /api/v1/customers", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    let list: (request: Request) => Promise<Response>;
    let create: (request: Request) => Promise<Response>;
    let read: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
    let patch: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;

    const staffUserId = "staffuser_01MTESTAPIAAAAAAAAAAAAAAA";
    let mineId = "";
    let theirsId = "";
    let staffToken = "";
    let readOnlyToken = "";
    let customerToken = "";

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        // The route modules capture `db` at import, so the URL has to point
        // at the test database before they are loaded — and the cached pool
        // from any earlier test file has to go with it.
        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        const listModule = await import("@/app/api/v1/customers/route");
        const itemModule = await import("@/app/api/v1/customers/[id]/route");

        list = listModule.GET;
        create = listModule.POST;
        read = itemModule.GET;
        patch = itemModule.PATCH;

        const { createApiKey } = await import("@/server/api-keys");
        const { createCustomer } = await import(
            "@/server/customers/repository"
        );

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Verwaltung",
            email: "verwaltung@example.test",
            emailVerified: true,
        });

        const [role] = await db
            .insert(schema.staffRole)
            .values({ name: "Alles", permissions: ["*"] })
            .returning();

        const [readRole] = await db
            .insert(schema.staffRole)
            .values({ name: "Nur lesen", permissions: ["customers.read"] })
            .returning();

        await db
            .insert(schema.staffRoleAssignment)
            .values({ staffUserId, roleId: role.id });

        const system = { type: "system" as const };

        mineId = (
            await createCustomer(
                db,
                {
                    kind: "company",
                    name: "Jana Brinkmann",
                    company: "Nordlicht Medien GmbH",
                    country: "DE",
                    currency: "EUR",
                    language: "de",
                    status: "active",
                    notes: "Interne Notiz.",
                },
                system,
            )
        ).id;

        theirsId = (
            await createCustomer(
                db,
                {
                    kind: "private",
                    name: "Tobias Weber",
                    country: "DE",
                    currency: "EUR",
                    language: "de",
                    status: "active",
                },
                system,
            )
        ).id;

        staffToken = (
            await createApiKey(
                db,
                {
                    name: "Verwaltung",
                    scopes: ["customers.read", "customers.write"],
                    owner: { type: "staff", staffUserId },
                },
                system,
            )
        ).token;

        // A second staff user, whose role grants reading only.
        await db.insert(schema.staffUser).values({
            id: "staffuser_01MTESTAPIREADONLYAAAAAAA",
            name: "Praktikum",
            email: "praktikum@example.test",
            emailVerified: true,
        });
        await db.insert(schema.staffRoleAssignment).values({
            staffUserId: "staffuser_01MTESTAPIREADONLYAAAAAAA",
            roleId: readRole.id,
        });

        readOnlyToken = (
            await createApiKey(
                db,
                {
                    name: "Nur lesen",
                    scopes: ["customers.read", "customers.write"],
                    owner: {
                        type: "staff",
                        staffUserId: "staffuser_01MTESTAPIREADONLYAAAAAAA",
                    },
                },
                system,
            )
        ).token;

        customerToken = (
            await createApiKey(
                db,
                {
                    name: "Kundenschlüssel",
                    scopes: ["customers.read", "customers.write"],
                    owner: { type: "customer", customerId: mineId },
                },
                system,
            )
        ).token;
    });

    afterAll(async () => {
        // The route handlers opened a pool of their own against this
        // database; it has to be closed before the database can be dropped.
        const { db: appDb } = await import("@/db");

        await (
            appDb as unknown as { $client: { end(): Promise<void> } }
        ).$client.end();
        delete (globalThis as { pool?: unknown }).pool;

        await drop?.();
    });

    const get = (path: string, token?: string) =>
        new Request(`https://virtify.net${path}`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
        });

    const send = (path: string, token: string, method: string, body: unknown) =>
        new Request(`https://virtify.net${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

    it("answers 401 without a key, and as a problem document", async () => {
        const response = await list(get("/api/v1/customers"));

        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toContain(
            "application/problem+json",
        );

        const body = await response.json();

        expect(body.status).toBe(401);
        expect(body.title).toBeTruthy();
    });

    it("answers 401 for a token that is not ours", async () => {
        expect((await list(get("/api/v1/customers", "nonsense"))).status).toBe(
            401,
        );
    });

    it("lists every account for a staff key", async () => {
        const response = await list(get("/api/v1/customers", staffToken));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.map((row: { id: string }) => row.id).sort()).toEqual(
            [mineId, theirsId].sort(),
        );
        expect(body).toHaveProperty("next_cursor");
        expect(body).toHaveProperty("has_more");
    });

    it("lists only its own account for a customer key", async () => {
        const response = await list(get("/api/v1/customers", customerToken));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toHaveLength(1);
        expect(body.data[0].id).toBe(mineId);
        // The operator's own notes are not the customer's to read.
        expect(body.data[0].notes).toBeNull();
    });

    it("answers 404, not 403, when a customer key asks for another account", async () => {
        const response = await read(
            get(`/api/v1/customers/${theirsId}`, customerToken),
            {
                params: Promise.resolve({ id: theirsId }),
            },
        );

        expect(response.status).toBe(404);
    });

    it("lets a customer key read its own account", async () => {
        const response = await read(
            get(`/api/v1/customers/${mineId}`, customerToken),
            { params: Promise.resolve({ id: mineId }) },
        );

        expect(response.status).toBe(200);
        expect((await response.json()).id).toBe(mineId);
    });

    it("refuses to create an account on a customer key", async () => {
        const response = await create(
            send("/api/v1/customers", customerToken, "POST", {
                name: "Fremdkonto",
            }),
        );

        expect(response.status).toBe(403);
    });

    it("refuses a staff key whose owner may only read", async () => {
        const response = await create(
            send("/api/v1/customers", readOnlyToken, "POST", {
                name: "Nicht erlaubt",
            }),
        );

        expect(response.status).toBe(403);
        expect((await response.json()).detail).toContain("customers.write");
    });

    it("creates an account on a staff key and gives it a number", async () => {
        const response = await create(
            send("/api/v1/customers", staffToken, "POST", {
                name: "Markus Hofer",
                company: "Alpstein Software OG",
                country: "at",
                vat_id: "ATU12345678",
            }),
        );

        expect(response.status).toBe(201);

        const body = await response.json();

        expect(body.customer_number).toBeGreaterThan(10000);
        expect(body.company).toBe("Alpstein Software OG");
        // The schema upper-cases it, so the tax layer never has to.
        expect(body.country).toBe("AT");
    });

    it("rejects an invalid body as 422 with the field named", async () => {
        const response = await create(
            send("/api/v1/customers", staffToken, "POST", {
                name: "",
                country: "Deutschland",
            }),
        );

        expect(response.status).toBe(422);

        const body = await response.json();

        expect(body.errors.map((e: { path: string }) => e.path)).toContain(
            "name",
        );
    });

    it("patches on a staff key and leaves a trail", async () => {
        const response = await patch(
            send(`/api/v1/customers/${theirsId}`, staffToken, "PATCH", {
                city: "Leipzig",
                notes: "Nur intern.",
            }),
            { params: Promise.resolve({ id: theirsId }) },
        );

        expect(response.status).toBe(200);
        expect((await response.json()).city).toBe("Leipzig");

        const log = await db.select().from(schema.auditLog);
        const entry = log.find(
            (row) =>
                row.entityId === theirsId && row.action === "customer.update",
        );

        expect(entry?.actorType).toBe("api");
        expect(entry?.after).toMatchObject({ city: "Leipzig" });
    });

    it("ignores status and notes from a customer key", async () => {
        const response = await patch(
            send(`/api/v1/customers/${mineId}`, customerToken, "PATCH", {
                city: "Kiel",
                status: "active",
                notes: "Selbst gesetzt.",
            }),
            { params: Promise.resolve({ id: mineId }) },
        );

        expect(response.status).toBe(200);

        const mine = (await db.select().from(schema.customer)).find(
            (entry) => entry.id === mineId,
        );

        expect(mine?.city).toBe("Kiel");
        // The note the operator wrote is untouched, and was never offered.
        expect(mine?.notes).toBe("Interne Notiz.");
    });

    it("will not patch another account on a customer key", async () => {
        const response = await patch(
            send(`/api/v1/customers/${theirsId}`, customerToken, "PATCH", {
                city: "Woanders",
            }),
            { params: Promise.resolve({ id: theirsId }) },
        );

        expect(response.status).toBe(404);

        const theirs = (await db.select().from(schema.customer)).find(
            (entry) => entry.id === theirsId,
        );

        expect(theirs?.city).toBe("Leipzig");
    });

    it("answers 404 for an id that does not exist", async () => {
        const missing = "customer_01MZZZZZZZZZZZZZZZZZZZZZZZ";
        const response = await read(
            get(`/api/v1/customers/${missing}`, staffToken),
            { params: Promise.resolve({ id: missing }) },
        );

        expect(response.status).toBe(404);
    });
});
