import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * `@react-pdf/renderer` cannot render under this vitest configuration, and
 * placing an order writes the first invoice's PDF after it commits. The
 * bytes are not what this file is about.
 */
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    renderToBuffer: async () => Buffer.from("%PDF-1.7 test"),
}));

/**
 * The three `/api/v1/services` endpoints end to end: the real route
 * handlers, the real bearer middleware, the real transactions.
 *
 * Three claims run through all of it.
 *
 * **A key is never more than its owner** (rule 5). A customer key that names
 * somebody else's service gets 404, not 403 — 403 would confirm the id
 * exists, and for a list of machines that is the one thing worth not
 * confirming. It gets 404 on the *action* too, not only on the read, which
 * is the half that is easy to forget.
 *
 * **A customer may not undo a suspension.** `unsuspend` is not on their list
 * at all, and no action runs on a service that is not `active`. Without
 * that, the whole dunning ladder is one request away from being reversed.
 *
 * **The route and the portal are one function.** Both end in
 * `requestServiceAction`, so there is one answer to "may this customer
 * reboot this machine" rather than two that can disagree.
 *
 * The handlers reach for `@/db` rather than taking an executor — a request
 * has no transaction to hand them — so this file points that module at the
 * throwaway database before importing them, which is why everything is a
 * dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("/api/v1/services", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    type Handler = (request: Request) => Promise<Response>;
    type ItemHandler = (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
    type ActionHandler = (
        request: Request,
        context: { params: Promise<{ id: string; action: string }> },
    ) => Promise<Response>;

    let list: Handler;
    let read: ItemHandler;
    let act: ActionHandler;

    const staffUserId = "staffuser_01MTESTSERVICESAAAAAAAAA";

    let staffToken = "";
    let readOnlyToken = "";
    let customerToken = "";
    let otherCustomerToken = "";

    let customerId = "";
    let otherCustomerId = "";
    let serviceId = "";
    let otherServiceId = "";
    let plainServiceId = "";

    const bearer = (token: string, url: string, method = "GET") =>
        new Request(url, {
            method,
            headers: { authorization: `Bearer ${token}` },
        });

    const params = (id: string) => ({ params: Promise.resolve({ id }) });
    const actionParams = (id: string, action: string) => ({
        params: Promise.resolve({ id, action }),
    });

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        list = (await import("@/app/api/v1/services/route")).GET;
        read = (await import("@/app/api/v1/services/[id]/route")).GET;
        act = (
            await import("@/app/api/v1/services/[id]/actions/[action]/route")
        ).POST;

        const { createApiKey } = await import("@/server/api-keys");
        const catalog = await import("@/server/catalog/repository");
        const { createCustomer } = await import(
            "@/server/customers/repository"
        );
        const { placeOrderFromItems } = await import("@/server/orders/service");

        const system = { type: "system" as const };

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Verwaltung",
            email: "leistungen@example.test",
            emailVerified: true,
        });

        const [role] = await db
            .insert(schema.staffRole)
            .values({ name: "Alles", permissions: ["*"] })
            .returning();

        await db
            .insert(schema.staffRoleAssignment)
            .values({ staffUserId, roleId: role.id });

        const group = await catalog.createGroup(
            db,
            {
                slug: "vps",
                name: "KVM-Instanzen",
                tagline: null,
                description: null,
                sortOrder: 0,
                hidden: false,
            },
            system,
        );

        const vps = await catalog.createProduct(
            db,
            {
                groupId: group.id,
                slug: "vps-m",
                name: "VPS M",
                type: "vps",
                status: "active",
                tagline: null,
                description: null,
                sortOrder: 0,
                module: "proxmox",
                moduleConfig: {
                    cores: 2,
                    memoryMiB: 2048,
                    diskGiB: 40,
                    ipv4Count: 0,
                    ipv6Count: 0,
                },
                maxQuantity: 5,
            },
            system,
        );

        /** A pure billing product: no module, and therefore no service row. */
        const support = await catalog.createProduct(
            db,
            {
                groupId: group.id,
                slug: "support",
                name: "Supportvertrag",
                type: "vps",
                status: "active",
                tagline: null,
                description: null,
                sortOrder: 1,
                module: "none",
                moduleConfig: {},
                maxQuantity: 5,
            },
            system,
        );

        for (const product of [vps, support]) {
            await catalog.setProductPricing(
                db,
                product.id,
                [
                    {
                        cycle: "monthly",
                        currency: "EUR",
                        priceCents: 1999,
                        setupFeeCents: 0,
                        trialDays: 0,
                    },
                ],
                system,
            );
        }

        const address = {
            street: "Musterweg 1",
            postalCode: "12345",
            city: "Musterstadt",
            country: "DE",
            currency: "EUR",
            language: "de" as const,
            status: "active" as const,
        };

        const buyer = await createCustomer(
            db,
            { kind: "private", name: "Tobias Weber", ...address },
            system,
        );
        const other = await createCustomer(
            db,
            { kind: "private", name: "Anja Roth", ...address },
            system,
        );

        customerId = buyer.id;
        otherCustomerId = other.id;

        for (const [who, productId] of [
            [customerId, vps.id],
            [otherCustomerId, vps.id],
            [customerId, support.id],
        ] as const) {
            await placeOrderFromItems(
                db,
                {
                    customerId: who,
                    items: [
                        {
                            productId,
                            cycle: "monthly",
                            currency: "EUR",
                            quantity: 1,
                            options: [],
                            couponCode: null,
                        },
                    ],
                    paymentOption: "bank_transfer",
                    autoCharge: false,
                    acceptance: {
                        terms: true,
                        withdrawal: true,
                        immediateStart: true,
                    },
                },
                system,
            );
        }

        const services = await db.select().from(schema.service);

        const serviceFor = (owner: string) => {
            const found = services.find((row) => row.customerId === owner);

            if (!found) {
                throw new Error(`no service was created for ${owner}`);
            }

            return found.id;
        };

        serviceId = serviceFor(customerId);
        otherServiceId = serviceFor(otherCustomerId);

        /**
         * A service on the `none` module, made by hand: Phase 4 gives a
         * product without provisioning no service row at all, and the
         * "nothing to steer" answer still has to be tested.
         */
        const [plain] = await db
            .insert(schema.service)
            .values({
                customerId,
                productId: support.id,
                label: "Supportvertrag",
                module: "none",
                status: "active",
            })
            .returning();

        plainServiceId = plain.id;

        const key = async (
            scopes: ("services.read" | "services.write")[],
            owner:
                | { type: "staff"; staffUserId: string }
                | { type: "customer"; customerId: string },
        ) =>
            (await createApiKey(db, { name: "Test", scopes, owner }, system))
                .token;

        staffToken = await key(["services.read", "services.write"], {
            type: "staff",
            staffUserId,
        });
        readOnlyToken = await key(["services.read"], {
            type: "staff",
            staffUserId,
        });
        customerToken = await key(["services.read", "services.write"], {
            type: "customer",
            customerId,
        });
        otherCustomerToken = await key(["services.read", "services.write"], {
            type: "customer",
            customerId: otherCustomerId,
        });
    }, 60_000);

    afterAll(async () => {
        const { db: appDb } = await import("@/db");

        await (
            appDb as unknown as { $client: { end(): Promise<void> } }
        ).$client.end();
        delete (globalThis as { pool?: unknown }).pool;

        await drop?.();
    });

    describe("GET /api/v1/services", () => {
        it("needs a key", async () => {
            const response = await list(
                new Request("https://virtify.test/api/v1/services"),
            );

            expect(response.status).toBe(401);
        });

        it("refuses a key without the scope", async () => {
            const { createApiKey } = await import("@/server/api-keys");
            const wrong = (
                await createApiKey(
                    db,
                    {
                        name: "Nur Rechnungen",
                        scopes: ["billing.read"],
                        owner: { type: "staff", staffUserId },
                    },
                    { type: "system" },
                )
            ).token;

            const response = await list(
                bearer(wrong, "https://virtify.test/api/v1/services"),
            );

            expect(response.status).toBe(403);
        });

        it("shows a staff key every customer's services", async () => {
            const response = await list(
                bearer(staffToken, "https://virtify.test/api/v1/services"),
            );
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.data.map((row: { id: string }) => row.id)).toEqual(
                expect.arrayContaining([serviceId, otherServiceId]),
            );
        });

        /**
         * The scope comes from the key, not from a parameter — there is no
         * `customer_id` on this endpoint to honour or to overwrite.
         */
        it("shows a customer key its own and nobody else's", async () => {
            const response = await list(
                bearer(customerToken, "https://virtify.test/api/v1/services"),
            );
            const body = await response.json();
            const ids = body.data.map((row: { id: string }) => row.id);

            expect(ids).toContain(serviceId);
            expect(ids).not.toContain(otherServiceId);
        });

        it("hides terminated services unless they are asked for", async () => {
            await db
                .update(schema.service)
                .set({ status: "terminated", terminatedAt: new Date() })
                .where(eq(schema.service.id, plainServiceId));

            const hidden = await (
                await list(
                    bearer(
                        customerToken,
                        "https://virtify.test/api/v1/services",
                    ),
                )
            ).json();

            expect(
                hidden.data.map((row: { id: string }) => row.id),
            ).not.toContain(plainServiceId);

            const shown = await (
                await list(
                    bearer(
                        customerToken,
                        "https://virtify.test/api/v1/services?include_terminated=true",
                    ),
                )
            ).json();

            expect(shown.data.map((row: { id: string }) => row.id)).toContain(
                plainServiceId,
            );

            await db
                .update(schema.service)
                .set({ status: "active", terminatedAt: null })
                .where(eq(schema.service.id, plainServiceId));
        });

        it("refuses a limit outside the range", async () => {
            const response = await list(
                bearer(
                    staffToken,
                    "https://virtify.test/api/v1/services?limit=5000",
                ),
            );

            expect(response.status).toBe(422);
        });
    });

    describe("GET /api/v1/services/{id}", () => {
        it("answers 404 for somebody else's service, not 403", async () => {
            const response = await read(
                bearer(
                    otherCustomerToken,
                    `https://virtify.test/api/v1/services/${serviceId}`,
                ),
                params(serviceId),
            );

            expect(response.status).toBe(404);
        });

        it("answers 404 for an id that does not exist", async () => {
            const response = await read(
                bearer(
                    staffToken,
                    "https://virtify.test/api/v1/services/service_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                ),
                params("service_01K9ZC4X7QG0VN3M8T6B2PFHRD"),
            );

            expect(response.status).toBe(404);
        });

        /**
         * The cluster, the VMID and the task log are the operator's
         * business. The provider's id in particular is an invitation to go
         * looking.
         */
        it("keeps the server, the VMID and the task log to staff", async () => {
            const mine = await (
                await read(
                    bearer(
                        customerToken,
                        `https://virtify.test/api/v1/services/${serviceId}`,
                    ),
                    params(serviceId),
                )
            ).json();

            expect(mine.id).toBe(serviceId);
            expect(mine).not.toHaveProperty("external_id");
            expect(mine).not.toHaveProperty("server_id");
            expect(mine).not.toHaveProperty("tasks");

            const theirs = await (
                await read(
                    bearer(
                        staffToken,
                        `https://virtify.test/api/v1/services/${serviceId}`,
                    ),
                    params(serviceId),
                )
            ).json();

            expect(theirs).toHaveProperty("external_id");
            expect(theirs).toHaveProperty("tasks");
        });

        /** Credentials are behind an audited reveal, never in a GET. */
        it("never puts credentials on the wire", async () => {
            const { encrypt } = await import("@/lib/crypto");

            await db
                .update(schema.service)
                .set({
                    credentialsEncrypted: encrypt(
                        JSON.stringify({
                            username: "root",
                            password: "hunter",
                        }),
                        `service.${serviceId}.credentials`,
                    ),
                })
                .where(eq(schema.service.id, serviceId));

            const body = await (
                await read(
                    bearer(
                        staffToken,
                        `https://virtify.test/api/v1/services/${serviceId}`,
                    ),
                    params(serviceId),
                )
            ).text();

            expect(body).not.toContain("hunter");
            expect(body).not.toContain("credentials_encrypted");
        });

        it("lists the actions the module offers, and no lifecycle ones", async () => {
            const body = await (
                await read(
                    bearer(
                        customerToken,
                        `https://virtify.test/api/v1/services/${serviceId}`,
                    ),
                    params(serviceId),
                )
            ).json();

            const ids = body.available_actions.map(
                (action: { id: string }) => action.id,
            );

            expect(ids).toContain("reboot");
            expect(ids).not.toContain("terminate");
            expect(ids).not.toContain("unsuspend");
        });
    });

    describe("POST /api/v1/services/{id}/actions/{action}", () => {
        it("needs the write scope", async () => {
            const response = await act(
                bearer(
                    readOnlyToken,
                    `https://virtify.test/api/v1/services/${serviceId}/actions/sync`,
                    "POST",
                ),
                actionParams(serviceId, "sync"),
            );

            expect(response.status).toBe(403);
        });

        it("refuses an action it has never heard of", async () => {
            const response = await act(
                bearer(
                    staffToken,
                    `https://virtify.test/api/v1/services/${serviceId}/actions/explode`,
                    "POST",
                ),
                actionParams(serviceId, "explode"),
            );

            expect(response.status).toBe(422);
        });

        /**
         * The half that is easy to forget: the 404 has to hold on the
         * *actions* too, or a customer who cannot read a service can still
         * reboot it.
         */
        it("answers 404 for an action on somebody else's service", async () => {
            const response = await act(
                bearer(
                    otherCustomerToken,
                    `https://virtify.test/api/v1/services/${serviceId}/actions/reboot`,
                    "POST",
                ),
                actionParams(serviceId, "reboot"),
            );

            expect(response.status).toBe(404);
        });

        it("refuses a staff-only action to a customer key", async () => {
            const response = await act(
                bearer(
                    customerToken,
                    `https://virtify.test/api/v1/services/${serviceId}/actions/terminate`,
                    "POST",
                ),
                actionParams(serviceId, "terminate"),
            );

            expect(response.status).toBe(409);

            const body = await response.json();

            expect(body.detail).toMatch(/nicht vorgesehen/);
        });

        it("refuses every action on a service that is not active", async () => {
            // A service suspended for an unpaid invoice. This is the guard
            // the whole dunning ladder leans on.
            await db
                .update(schema.service)
                .set({ status: "suspended", suspendedAt: new Date() })
                .where(eq(schema.service.id, serviceId));

            const response = await act(
                bearer(
                    customerToken,
                    `https://virtify.test/api/v1/services/${serviceId}/actions/start`,
                    "POST",
                ),
                actionParams(serviceId, "start"),
            );

            const body = await response.json();

            expect(response.status).toBe(502);
            expect(body.ok).toBe(false);
            expect(body.summary).toMatch(/suspended/);

            await db
                .update(schema.service)
                .set({ status: "active", suspendedAt: null })
                .where(eq(schema.service.id, serviceId));
        });

        it("says there is nothing to steer on a module that provisions nothing", async () => {
            const response = await act(
                bearer(
                    staffToken,
                    `https://virtify.test/api/v1/services/${plainServiceId}/actions/sync`,
                    "POST",
                ),
                actionParams(plainServiceId, "sync"),
            );

            expect(response.status).toBe(409);
            expect((await response.json()).detail).toMatch(/nur abgerechnet/);
        });

        /**
         * No server is configured in this suite, so the attempt aborts
         * before anything is asked of a cluster — which is the honest answer
         * and is reported as one. `ok: false` with a 502, and the body has
         * the same shape as a success so a client reads `ok` rather than
         * guessing from the status.
         */
        it("reports a cluster it cannot reach as 502 with the same body shape", async () => {
            const response = await act(
                bearer(
                    staffToken,
                    `https://virtify.test/api/v1/services/${serviceId}/actions/sync`,
                    "POST",
                ),
                actionParams(serviceId, "sync"),
            );
            const body = await response.json();

            expect(response.status).toBe(502);
            expect(body.ok).toBe(false);
            expect(body).toHaveProperty("task_id");
            expect(body).toHaveProperty("already_done");
            expect(body).toHaveProperty("warnings");
        });
    });
});
