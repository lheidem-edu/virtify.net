import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * `@react-pdf/renderer` cannot render under this vitest configuration, and
 * `POST /api/v1/orders` writes the first invoice's PDF after it commits.
 * The bytes are not what this file is about — the status codes, the scoping
 * and the body are — so the renderer is replaced by something that returns
 * a few bytes.
 */
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    renderToBuffer: async () => Buffer.from("%PDF-1.7 test"),
}));

/**
 * `/api/v1/orders` end to end: the real route handlers, the real bearer
 * middleware, the real transaction.
 *
 * The handlers reach for `@/db` rather than taking an executor — a request
 * has no transaction to hand them — so this file points that module at the
 * throwaway database before importing them, which is why everything is a
 * dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("POST/GET /api/v1/orders", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    let place: (request: Request) => Promise<Response>;
    let read: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;

    const staffUserId = "staffuser_01MTESTORDERSAAAAAAAAAAA";

    let staffToken = "";
    let readOnlyToken = "";
    let customerToken = "";
    let otherCustomerToken = "";

    let customerId = "";
    let otherCustomerId = "";
    let productId = "";

    const bearer = (token: string, url: string, body?: unknown) =>
        new Request(url, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                ...(body === undefined
                    ? {}
                    : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    const ORDER = {
        items: [
            {
                product_id: "vps-m",
                cycle: "monthly" as const,
                currency: "EUR",
                quantity: 1,
                options: [],
            },
        ],
        payment_option: "bank_transfer" as const,
        accept_terms: true,
        accept_withdrawal: true,
        request_immediate_start: true,
    };

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        const listModule = await import("@/app/api/v1/orders/route");
        const itemModule = await import("@/app/api/v1/orders/[id]/route");

        place = listModule.POST;
        read = itemModule.GET;

        const { createApiKey } = await import("@/server/api-keys");
        const catalog = await import("@/server/catalog/repository");
        const { createCustomer } = await import(
            "@/server/customers/repository"
        );

        const system = { type: "system" as const };

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Verwaltung",
            email: "bestellungen@example.test",
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

        const product = await catalog.createProduct(
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
                module: "none",
                moduleConfig: {},
                maxQuantity: 3,
            },
            system,
        );

        productId = product.id;

        await catalog.setProductPricing(
            db,
            productId,
            [
                {
                    cycle: "monthly",
                    currency: "EUR",
                    priceCents: 1999,
                    setupFeeCents: 1000,
                    trialDays: 0,
                },
            ],
            system,
        );

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

        staffToken = (
            await createApiKey(
                db,
                {
                    name: "Verwaltung",
                    scopes: ["orders.read", "orders.write"],
                    owner: { type: "staff", staffUserId },
                },
                system,
            )
        ).token;

        readOnlyToken = (
            await createApiKey(
                db,
                {
                    name: "Nur lesen",
                    scopes: ["orders.read"],
                    owner: { type: "staff", staffUserId },
                },
                system,
            )
        ).token;

        customerToken = (
            await createApiKey(
                db,
                {
                    name: "Shop",
                    scopes: ["orders.read", "orders.write"],
                    owner: { type: "customer", customerId },
                },
                system,
            )
        ).token;

        otherCustomerToken = (
            await createApiKey(
                db,
                {
                    name: "Shop",
                    scopes: ["orders.read"],
                    owner: { type: "customer", customerId: otherCustomerId },
                },
                system,
            )
        ).token;
    }, 60_000);

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

    beforeEach(async () => {
        // TRUNCATE, because the immutability triggers refuse a DELETE on a
        // finalized invoice — which is exactly what they are for.
        await db.execute(
            `truncate table "service", "subscription_item", "subscription",
                 "order_item", "order", "credit_note_item", "credit_note",
                 "invoice_item", "invoice", "cart_item", "cart",
                 "document_counter" cascade`,
        );
    });

    it("refuses a request without a key", async () => {
        const response = await place(
            new Request("https://example.test/api/v1/orders", {
                method: "POST",
                body: JSON.stringify(ORDER),
            }),
        );

        expect(response.status).toBe(401);
    });

    it("refuses a key that does not carry orders.write", async () => {
        const response = await place(
            bearer(readOnlyToken, "https://example.test/api/v1/orders", {
                ...ORDER,
                customer_id: customerId,
            }),
        );

        expect(response.status).toBe(403);
    });

    it("places an order for a customer key's own account", async () => {
        const response = await place(
            bearer(customerToken, "https://example.test/api/v1/orders", {
                ...ORDER,
                // Ignored rather than honoured: a customer key orders for
                // itself, whatever the body says.
                customer_id: otherCustomerId,
            }),
        );

        expect(response.status).toBe(201);

        const body = await response.json();

        expect(body.customer_id).toBe(customerId);
        expect(body.status).toBe("pending");
        expect(body.number).toMatch(/^BS-\d{4}-\d{4}$/);
        // 19,99 € + 10,00 €, no VAT under § 19 UStG.
        expect(body.net_cents).toBe(2999);
        expect(body.tax_cents).toBe(0);
        expect(body.gross_cents).toBe(2999);
        expect(body.invoice_number).toMatch(/^RE-\d{4}-\d{4}$/);

        // The documented body carries everything the order produced, read
        // back from the database rather than echoed from the request.
        expect(body.items).toHaveLength(1);
        expect(body.items[0].due_today_cents).toBe(2999);
        expect(body.subscriptions).toHaveLength(1);
        expect(body.subscriptions[0].cycle).toBe("monthly");
        expect(body.subscriptions[0].items[0].recurring_gross_cents).toBe(1999);
        expect(body.services).toHaveLength(1);
        expect(body.services[0].status).toBe("pending");
        expect(body.terms_accepted_at).toBeTruthy();
        expect(body.is_consumer).toBe(true);
    });

    it("makes a staff key name the account", async () => {
        const response = await place(
            bearer(staffToken, "https://example.test/api/v1/orders", ORDER),
        );

        expect(response.status).toBe(422);
        expect((await response.json()).detail).toContain("customer_id");
    });

    it("lets a staff key order for a named account", async () => {
        const response = await place(
            bearer(staffToken, "https://example.test/api/v1/orders", {
                ...ORDER,
                customer_id: otherCustomerId,
            }),
        );

        expect(response.status).toBe(201);
        expect((await response.json()).customer_id).toBe(otherCustomerId);
    });

    it("refuses an order that does not accept the AGB", async () => {
        const response = await place(
            bearer(customerToken, "https://example.test/api/v1/orders", {
                ...ORDER,
                accept_terms: false,
            }),
        );

        expect(response.status).toBe(422);
        expect((await response.json()).detail).toContain(
            "Geschäftsbedingungen",
        );

        // And nothing was written: no order, no invoice, no cart left over.
        expect(await db.select().from(schema.order)).toHaveLength(0);
        expect(await db.select().from(schema.invoice)).toHaveLength(0);
        expect(await db.select().from(schema.cart)).toHaveLength(0);
    });

    it("names the field when the body is malformed", async () => {
        const response = await place(
            bearer(customerToken, "https://example.test/api/v1/orders", {
                ...ORDER,
                items: [{ ...ORDER.items[0], quantity: 0 }],
            }),
        );

        expect(response.status).toBe(422);

        const body = await response.json();

        expect(body.errors[0].path).toBe("items.0.quantity");
    });

    it("refuses a product that is not for sale", async () => {
        const response = await place(
            bearer(customerToken, "https://example.test/api/v1/orders", {
                ...ORDER,
                items: [{ ...ORDER.items[0], product_id: "gibt-es-nicht" }],
            }),
        );

        expect(response.status).toBe(422);
        expect((await response.json()).detail).toContain("nicht bestellbar");
    });

    it("reads an order back, and hides another account's", async () => {
        const created = await place(
            bearer(customerToken, "https://example.test/api/v1/orders", ORDER),
        );

        const { id } = await created.json();

        const own = await read(
            bearer(customerToken, `https://example.test/api/v1/orders/${id}`),
            { params: Promise.resolve({ id }) },
        );

        expect(own.status).toBe(200);
        expect((await own.json()).id).toBe(id);

        // 404 and never 403: 403 would confirm that the id exists.
        const foreign = await read(
            bearer(
                otherCustomerToken,
                `https://example.test/api/v1/orders/${id}`,
            ),
            { params: Promise.resolve({ id }) },
        );

        expect(foreign.status).toBe(404);

        // Staff see every account's.
        const staff = await read(
            bearer(staffToken, `https://example.test/api/v1/orders/${id}`),
            { params: Promise.resolve({ id }) },
        );

        expect(staff.status).toBe(200);
    });

    it("answers 404 for an id that does not exist", async () => {
        const id = "order_01MTESTNOSUCHORDERAAAAAAA";

        const response = await read(
            bearer(staffToken, `https://example.test/api/v1/orders/${id}`),
            { params: Promise.resolve({ id }) },
        );

        expect(response.status).toBe(404);
    });

    it("stores the first invoice's PDF after the order commits", async () => {
        const created = await place(
            bearer(customerToken, "https://example.test/api/v1/orders", ORDER),
        );

        const { invoice_id } = await created.json();

        const [invoice] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoice_id));

        expect(invoice.pdfKey).toBeTruthy();
        expect(invoice.pdfSha256).toBeTruthy();
    });
});
