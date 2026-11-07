import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * `/api/v1/products` end to end: the real route handlers, the real bearer
 * middleware, the real queries.
 *
 * The handlers reach for `@/db` rather than taking an executor — they are
 * route handlers, and a request has no transaction to hand them — so this
 * file points that module at the throwaway database before importing them.
 * That is why everything here is a dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("GET/POST /api/v1/products", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    let list: (request: Request) => Promise<Response>;
    let read: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
    let price: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;

    const staffUserId = "staffuser_01MTESTCATALOGAAAAAAAAAA";

    let staffToken = "";
    let blindToken = "";
    let customerToken = "";

    let productId = "";
    let draftId = "";
    let ramOptionId = "";
    let sixteenGbId = "";

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

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        const listModule = await import("@/app/api/v1/products/route");
        const itemModule = await import("@/app/api/v1/products/[id]/route");
        const quoteModule = await import(
            "@/app/api/v1/products/[id]/quote/route"
        );

        list = listModule.GET;
        read = itemModule.GET;
        price = quoteModule.POST;

        const { createApiKey } = await import("@/server/api-keys");
        const catalog = await import("@/server/catalog/repository");
        const { createCustomer } = await import(
            "@/server/customers/repository"
        );

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Verwaltung",
            email: "katalog@example.test",
            emailVerified: true,
        });

        const [role] = await db
            .insert(schema.staffRole)
            .values({ name: "Alles", permissions: ["*"] })
            .returning();

        await db
            .insert(schema.staffRoleAssignment)
            .values({ staffUserId, roleId: role.id });

        const system = { type: "system" as const };

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
                tagline: "4 vCPU, 8 GB RAM",
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

        const option = await catalog.createConfigOption(
            db,
            productId,
            {
                name: "Arbeitsspeicher",
                description: null,
                type: "select",
                required: false,
                sortOrder: 0,
                minQuantity: 0,
                maxQuantity: 10,
            },
            system,
        );

        ramOptionId = option?.id ?? "";

        const values = await catalog.setConfigOptionValues(
            db,
            ramOptionId,
            [
                { name: "8 GB", sortOrder: 0, isDefault: true, pricing: [] },
                {
                    name: "16 GB",
                    sortOrder: 1,
                    isDefault: false,
                    pricing: [
                        {
                            cycle: "monthly",
                            currency: "EUR",
                            priceCents: 500,
                            setupFeeCents: 200,
                        },
                    ],
                },
            ],
            system,
        );

        sixteenGbId = values?.find((row) => row.name === "16 GB")?.id ?? "";

        draftId = (
            await catalog.createProduct(
                db,
                {
                    groupId: group.id,
                    slug: "vps-xl",
                    name: "VPS XL",
                    type: "vps",
                    status: "draft",
                    tagline: null,
                    description: null,
                    sortOrder: 0,
                    module: "none",
                    moduleConfig: {},
                    maxQuantity: 1,
                },
                system,
            )
        ).id;

        await catalog.createCoupon(
            db,
            {
                code: "WILLKOMMEN",
                description: null,
                kind: "percent",
                percentBasisPoints: 2500,
                amountCents: null,
                currency: null,
                duration: "once",
                durationPeriods: null,
                appliesToSetupFee: false,
                productIds: [],
                cycles: [],
                validFrom: null,
                validUntil: null,
                maxRedemptions: null,
                active: true,
            },
            system,
        );

        staffToken = (
            await createApiKey(
                db,
                {
                    name: "Katalog",
                    scopes: ["catalog.read"],
                    owner: { type: "staff", staffUserId },
                },
                system,
            )
        ).token;

        // A key whose owner holds no role at all: the scope is on the key,
        // the permission is not on the person, and the key must shrink to it.
        const [stranger] = await db
            .insert(schema.staffUser)
            .values({
                id: "staffuser_01MTESTCATALOGBBBBBBBBBB",
                name: "Ohne Rolle",
                email: "ohnerolle@example.test",
                emailVerified: true,
            })
            .returning();

        blindToken = (
            await createApiKey(
                db,
                {
                    name: "Ohne Rolle",
                    scopes: ["catalog.read"],
                    owner: { type: "staff", staffUserId: stranger.id },
                },
                system,
            )
        ).token;

        const customer = await createCustomer(
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
        );

        customerToken = (
            await createApiKey(
                db,
                {
                    name: "Shop",
                    scopes: ["catalog.read"],
                    owner: { type: "customer", customerId: customer.id },
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

    it("refuses a request without a key", async () => {
        const response = await list(
            new Request("https://example.test/api/v1/products"),
        );

        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toContain(
            "application/problem+json",
        );
    });

    it("refuses a key whose owner no longer holds the permission", async () => {
        const response = await list(
            bearer(blindToken, "https://example.test/api/v1/products"),
        );

        expect(response.status).toBe(403);
    });

    it("lists what is for sale and leaves out the drafts", async () => {
        const response = await list(
            bearer(staffToken, "https://example.test/api/v1/products"),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.map((row: { id: string }) => row.id)).toEqual([
            productId,
        ]);
        expect(body.data[0].pricing).toEqual([
            {
                cycle: "monthly",
                currency: "EUR",
                price_cents: 1999,
                setup_fee_cents: 1000,
                trial_days: 0,
            },
        ]);
        expect(body.data[0].group.slug).toBe("vps");
        expect(body.has_more).toBe(false);
    });

    it("lets a customer's own key read the catalog", async () => {
        const response = await list(
            bearer(customerToken, "https://example.test/api/v1/products"),
        );

        expect(response.status).toBe(200);
        expect((await response.json()).data).toHaveLength(1);
    });

    it("filters by group slug as well as by id", async () => {
        const bySlug = await list(
            bearer(
                staffToken,
                "https://example.test/api/v1/products?group=vps",
            ),
        );
        const byNothing = await list(
            bearer(
                staffToken,
                "https://example.test/api/v1/products?group=gibtsnicht",
            ),
        );

        expect((await bySlug.json()).data).toHaveLength(1);
        expect((await byNothing.json()).data).toHaveLength(0);
    });

    it("hands back the options along with the product", async () => {
        const response = await read(
            bearer(
                staffToken,
                `https://example.test/api/v1/products/${productId}`,
            ),
            { params: Promise.resolve({ id: productId }) },
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.config_options).toHaveLength(1);
        expect(
            body.config_options[0].values.map((v: { name: string }) => v.name),
        ).toEqual(["8 GB", "16 GB"]);
        // The operator's module configuration is not a buyer's business.
        expect(body.module_config).toBeUndefined();
    });

    it("takes the slug in the path as well as the id", async () => {
        const response = await read(
            bearer(staffToken, "https://example.test/api/v1/products/vps-m"),
            { params: Promise.resolve({ id: "vps-m" }) },
        );

        expect((await response.json()).id).toBe(productId);
    });

    it("answers 404 for a draft, not 403", async () => {
        const response = await read(
            bearer(
                staffToken,
                `https://example.test/api/v1/products/${draftId}`,
            ),
            { params: Promise.resolve({ id: draftId }) },
        );

        expect(response.status).toBe(404);
    });

    it("prices a configuration down to the cent", async () => {
        const response = await price(
            bearer(
                staffToken,
                `https://example.test/api/v1/products/${productId}/quote`,
                {
                    cycle: "monthly",
                    currency: "EUR",
                    quantity: 2,
                    options: [
                        {
                            option_id: ramOptionId,
                            value_id: sixteenGbId,
                            quantity: 1,
                        },
                    ],
                    coupon_code: null,
                },
            ),
            { params: Promise.resolve({ id: productId }) },
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        // 2 × 19,99 € + 2 × 5,00 €.
        expect(body.totals.recurring_gross_cents).toBe(4998);
        // 2 × 10,00 € Produkt + 2 × 2,00 € Option.
        expect(body.totals.setup_cents).toBe(2400);
        expect(body.totals.due_today_cents).toBe(7398);
        expect(body.lines.map((line: { kind: string }) => line.kind)).toEqual([
            "base",
            "option",
            "setup",
            "setup",
        ]);
    });

    it("applies a coupon and says what it was worth", async () => {
        const response = await price(
            bearer(
                staffToken,
                `https://example.test/api/v1/products/${productId}/quote`,
                {
                    cycle: "monthly",
                    currency: "EUR",
                    quantity: 1,
                    options: [],
                    coupon_code: "willkommen",
                },
            ),
            { params: Promise.resolve({ id: productId }) },
        );
        const body = await response.json();

        expect(body.coupon.code).toBe("WILLKOMMEN");
        expect(body.coupon.label).toBe("25 %");
        expect(body.totals.recurring_discount_cents).toBe(500);
        expect(body.totals.first_period_cents).toBe(1499);
        expect(body.totals.renewal_cents).toBe(1999);
        expect(body.totals.discount_periods).toBe(1);
    });

    it("answers 422 for a cycle that is not offered", async () => {
        const response = await price(
            bearer(
                staffToken,
                `https://example.test/api/v1/products/${productId}/quote`,
                {
                    cycle: "annual",
                    currency: "EUR",
                    quantity: 1,
                    options: [],
                    coupon_code: null,
                },
            ),
            { params: Promise.resolve({ id: productId }) },
        );

        expect(response.status).toBe(422);
        expect((await response.json()).detail).toContain("nicht angeboten");
    });

    it("answers 422 for more than the product may be ordered in", async () => {
        const response = await price(
            bearer(
                staffToken,
                `https://example.test/api/v1/products/${productId}/quote`,
                {
                    cycle: "monthly",
                    currency: "EUR",
                    quantity: 99,
                    options: [],
                    coupon_code: null,
                },
            ),
            { params: Promise.resolve({ id: productId }) },
        );

        expect(response.status).toBe(422);
    });

    it("will not price a draft", async () => {
        const response = await price(
            bearer(
                staffToken,
                `https://example.test/api/v1/products/${draftId}/quote`,
                {
                    cycle: "monthly",
                    currency: "EUR",
                    quantity: 1,
                    options: [],
                    coupon_code: null,
                },
            ),
            { params: Promise.resolve({ id: draftId }) },
        );

        expect(response.status).toBe(404);
    });
});
