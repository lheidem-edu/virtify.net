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
 * creating an Abo writes the first invoice's PDF after it commits. The bytes
 * are not what this file is about.
 */
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    renderToBuffer: async () => Buffer.from("%PDF-1.7 test"),
}));

/**
 * The eight `/api/v1/subscriptions` endpoints end to end: the real route
 * handlers, the real bearer middleware, the real transactions.
 *
 * Two claims run through all of it. **A key is never more than its owner**
 * (rule 5): a customer key that names somebody else's Abo gets 404, not 403,
 * because 403 would confirm the id exists — and it gets 404 on the *actions*
 * too, not only on the reads, which is the half that is easy to forget.
 * **The preview is the price**: `GET …/preview-change` and `POST …/change`
 * come out of one function, and the test pins them to the same cents.
 *
 * The handlers reach for `@/db` rather than taking an executor — a request
 * has no transaction to hand them — so this file points that module at the
 * throwaway database before importing them, which is why everything is a
 * dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("/api/v1/subscriptions", () => {
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
    let cancel: ItemHandler;
    let pause: ItemHandler;
    let resume: ItemHandler;
    let change: ItemHandler;
    let preview: ItemHandler;

    const staffUserId = "staffuser_01MTESTSUBSAAAAAAAAAAAAA";

    let staffToken = "";
    let readOnlyToken = "";
    let customerToken = "";
    let otherCustomerToken = "";

    let customerId = "";
    let otherCustomerId = "";
    let smallId = "";
    let largeId = "";

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

    const NEW_SUBSCRIPTION = {
        items: [{ product_id: "vps-m", quantity: 1, options: [] }],
        cycle: "monthly" as const,
        currency: "EUR",
        accept_terms: true,
        accept_withdrawal: true,
        request_immediate_start: true,
    };

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        list = (await import("@/app/api/v1/subscriptions/route")).GET;
        create = (await import("@/app/api/v1/subscriptions/route")).POST;
        read = (await import("@/app/api/v1/subscriptions/[id]/route")).GET;
        cancel = (await import("@/app/api/v1/subscriptions/[id]/cancel/route"))
            .POST;
        pause = (await import("@/app/api/v1/subscriptions/[id]/pause/route"))
            .POST;
        resume = (await import("@/app/api/v1/subscriptions/[id]/resume/route"))
            .POST;
        change = (await import("@/app/api/v1/subscriptions/[id]/change/route"))
            .POST;
        preview = (
            await import("@/app/api/v1/subscriptions/[id]/preview-change/route")
        ).GET;

        const { createApiKey } = await import("@/server/api-keys");
        const catalog = await import("@/server/catalog/repository");
        const { createCustomer } = await import(
            "@/server/customers/repository"
        );

        const system = { type: "system" as const };

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Verwaltung",
            email: "abos@example.test",
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

        for (const [slug, name, priceCents] of [
            ["vps-m", "VPS M", 1999],
            ["vps-l", "VPS L", 3999],
        ] as const) {
            const product = await catalog.createProduct(
                db,
                {
                    groupId: group.id,
                    slug,
                    name,
                    type: "vps",
                    status: "active",
                    tagline: null,
                    description: null,
                    sortOrder: 0,
                    module: "none",
                    moduleConfig: {},
                    maxQuantity: 5,
                },
                system,
            );

            if (slug === "vps-m") {
                smallId = product.id;
            } else {
                largeId = product.id;
            }

            await catalog.setProductPricing(
                db,
                product.id,
                [
                    {
                        cycle: "monthly",
                        currency: "EUR",
                        priceCents,
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

        const key = async (
            scopes: ("subscriptions.read" | "subscriptions.write")[],
            owner:
                | { type: "staff"; staffUserId: string }
                | { type: "customer"; customerId: string },
        ) =>
            (await createApiKey(db, { name: "Test", scopes, owner }, system))
                .token;

        staffToken = await key(["subscriptions.read", "subscriptions.write"], {
            type: "staff",
            staffUserId,
        });
        readOnlyToken = await key(["subscriptions.read"], {
            type: "staff",
            staffUserId,
        });
        customerToken = await key(
            ["subscriptions.read", "subscriptions.write"],
            { type: "customer", customerId },
        );
        otherCustomerToken = await key(
            ["subscriptions.read", "subscriptions.write"],
            { type: "customer", customerId: otherCustomerId },
        );
    }, 60_000);

    afterAll(async () => {
        const { db: appDb } = await import("@/db");

        await (
            appDb as unknown as { $client: { end(): Promise<void> } }
        ).$client.end();
        delete (globalThis as { pool?: unknown }).pool;

        await drop?.();
    });

    /** Creates an Abo for the main customer and returns its body. */
    async function makeSubscription() {
        const response = await create(
            bearer(staffToken, "https://virtify.test/api/v1/subscriptions", {
                ...NEW_SUBSCRIPTION,
                customer_id: customerId,
            }),
        );

        expect(response.status).toBe(201);

        return response.json();
    }

    describe("POST /api/v1/subscriptions", () => {
        it("creates one through the same transaction as the checkout", async () => {
            const body = await makeSubscription();

            expect(body.status).toBe("active");
            expect(body.cycle).toBe("monthly");
            expect(body.period_gross_cents).toBe(1999);
            expect(body.items).toHaveLength(1);
            expect(body.items[0].unit_price_cents).toBe(1999);

            // The order and the finalized first invoice came with it.
            expect(body.order_id).toBeTruthy();
            expect(body.invoices).toHaveLength(1);
            expect(body.invoices[0].kind).toBe("initial");
            expect(body.invoices[0].number).toMatch(/^RE-/);
        });

        it("refuses a staff key that names no account", async () => {
            const response = await create(
                bearer(
                    staffToken,
                    "https://virtify.test/api/v1/subscriptions",
                    NEW_SUBSCRIPTION,
                ),
            );

            expect(response.status).toBe(422);
        });

        it("ignores `customer_id` from a customer key", async () => {
            const response = await create(
                bearer(
                    customerToken,
                    "https://virtify.test/api/v1/subscriptions",
                    { ...NEW_SUBSCRIPTION, customer_id: otherCustomerId },
                ),
            );

            expect(response.status).toBe(201);
            expect((await response.json()).customer_id).toBe(customerId);
        });

        it("refuses a key without `subscriptions.write`", async () => {
            const response = await create(
                bearer(
                    readOnlyToken,
                    "https://virtify.test/api/v1/subscriptions",
                    { ...NEW_SUBSCRIPTION, customer_id: customerId },
                ),
            );

            expect(response.status).toBe(403);
        });

        it("refuses an unaccepted AGB", async () => {
            const response = await create(
                bearer(
                    staffToken,
                    "https://virtify.test/api/v1/subscriptions",
                    {
                        ...NEW_SUBSCRIPTION,
                        customer_id: customerId,
                        accept_terms: false,
                    },
                ),
            );

            expect(response.status).toBe(422);
        });
    });

    describe("GET /api/v1/subscriptions", () => {
        it("gives a customer key only its own account's Abos", async () => {
            await makeSubscription();

            const response = await list(
                bearer(
                    otherCustomerToken,
                    "https://virtify.test/api/v1/subscriptions",
                ),
            );

            expect(response.status).toBe(200);

            const body = await response.json();

            for (const row of body.data) {
                expect(row.customer_id).toBe(otherCustomerId);
            }
        });

        it("overrides `customer_id` for a customer key rather than obeying it", async () => {
            const response = await list(
                bearer(
                    otherCustomerToken,
                    `https://virtify.test/api/v1/subscriptions?customer_id=${customerId}`,
                ),
            );

            const body = await response.json();

            for (const row of body.data) {
                expect(row.customer_id).toBe(otherCustomerId);
            }
        });

        it("pages by ULID cursor", async () => {
            const first = await (
                await list(
                    bearer(
                        staffToken,
                        "https://virtify.test/api/v1/subscriptions?limit=1",
                    ),
                )
            ).json();

            expect(first.data).toHaveLength(1);
            expect(first.has_more).toBe(true);
            expect(first.next_cursor).toBeTruthy();
        });
    });

    describe("GET /api/v1/subscriptions/{id}", () => {
        it("answers 404 — not 403 — for another account's Abo", async () => {
            const own = await makeSubscription();

            const response = await read(
                bearer(
                    otherCustomerToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}`,
                ),
                params(own.id),
            );

            expect(response.status).toBe(404);
        });
    });

    describe("the actions are scoped too", () => {
        it("answers 404 on cancel, pause, resume and change for a foreign Abo", async () => {
            const own = await makeSubscription();
            const url = `https://virtify.test/api/v1/subscriptions/${own.id}`;

            for (const [name, handler, body] of [
                ["cancel", cancel, { when: "now" }],
                ["pause", pause, {}],
                ["resume", resume, {}],
                [
                    "change",
                    change,
                    { item_id: own.items[0].id, product_id: "vps-l" },
                ],
            ] as const) {
                const response = await handler(
                    bearer(otherCustomerToken, `${url}/${name}`, body),
                    params(own.id),
                );

                expect(response.status, name).toBe(404);
            }

            // And the Abo is untouched.
            const [row] = await db
                .select()
                .from(schema.subscription)
                .where(eq(schema.subscription.id, own.id));

            expect(row.status).toBe("active");
        });

        it("refuses a read-only key on an action", async () => {
            const own = await makeSubscription();

            const response = await pause(
                bearer(
                    readOnlyToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/pause`,
                    {},
                ),
                params(own.id),
            );

            expect(response.status).toBe(403);
        });
    });

    describe("cancel, pause and resume", () => {
        it("cancels at the end of the period by default", async () => {
            const own = await makeSubscription();

            const response = await cancel(
                bearer(
                    customerToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/cancel`,
                    {},
                ),
                params(own.id),
            );

            expect(response.status).toBe(200);

            const body = await response.json();

            expect(body.status).toBe("cancelled");
            expect(body.cancel_at_period_end).toBe(true);
        });

        it("takes the cancellation back", async () => {
            const own = await makeSubscription();

            await cancel(
                bearer(
                    customerToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/cancel`,
                    {},
                ),
                params(own.id),
            );

            const response = await resume(
                bearer(
                    customerToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/resume`,
                    {},
                ),
                params(own.id),
            );

            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.status).toBe("active");
            expect(body.cancel_at_period_end).toBe(false);
        });

        it("pauses and resumes, and `auto` picks the right one", async () => {
            const own = await makeSubscription();

            const paused = await (
                await pause(
                    bearer(
                        customerToken,
                        `https://virtify.test/api/v1/subscriptions/${own.id}/pause`,
                        {},
                    ),
                    params(own.id),
                )
            ).json();

            expect(paused.status).toBe("paused");
            expect(paused.next_billing_at).toBeNull();

            const resumed = await (
                await resume(
                    bearer(
                        customerToken,
                        `https://virtify.test/api/v1/subscriptions/${own.id}/resume`,
                        {},
                    ),
                    params(own.id),
                )
            ).json();

            expect(resumed.status).toBe("active");
            expect(resumed.next_billing_at).toBeTruthy();
        });

        it("answers 409 when the state does not allow it", async () => {
            const own = await makeSubscription();

            await cancel(
                bearer(
                    staffToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/cancel`,
                    { when: "now" },
                ),
                params(own.id),
            );

            const response = await cancel(
                bearer(
                    staffToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/cancel`,
                    { when: "now" },
                ),
                params(own.id),
            );

            expect(response.status).toBe(409);
            expect(response.headers.get("content-type")).toContain(
                "problem+json",
            );
        });
    });

    describe("the preview and the change are one number", () => {
        it("charges exactly what the preview quoted", async () => {
            const own = await makeSubscription();
            const itemId = own.items[0].id;
            const url = `https://virtify.test/api/v1/subscriptions/${own.id}`;

            const quoted = await (
                await preview(
                    bearer(
                        customerToken,
                        `${url}/preview-change?item_id=${itemId}&product_id=vps-l&effective=immediately`,
                    ),
                    params(own.id),
                )
            ).json();

            expect(quoted.direction).toBe("upgrade");
            expect(quoted.next.recurring_gross_cents).toBe(3999);
            expect(quoted.summary).toContain("Heute");

            const booked = await (
                await change(
                    bearer(customerToken, `${url}/change`, {
                        item_id: itemId,
                        product_id: "vps-l",
                        effective: "immediately",
                    }),
                    params(own.id),
                )
            ).json();

            expect(booked.applied_now).toBe(true);
            expect(booked.preview.invoice_today_cents).toBe(
                quoted.invoice_today_cents,
            );

            if (quoted.invoice_today_cents > 0) {
                const [invoice] = await db
                    .select()
                    .from(schema.invoice)
                    .where(eq(schema.invoice.id, booked.invoice_id));

                expect(invoice.grossCents).toBe(quoted.invoice_today_cents);
            }

            expect(booked.subscription.items[0].product_id).toBe(largeId);
            expect(booked.subscription.period_gross_cents).toBe(3999);
        });

        it("previews without changing anything", async () => {
            const own = await makeSubscription();
            const itemId = own.items[0].id;

            await preview(
                bearer(
                    customerToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/preview-change?item_id=${itemId}&product_id=vps-l`,
                ),
                params(own.id),
            );

            const [row] = await db
                .select()
                .from(schema.subscriptionItem)
                .where(eq(schema.subscriptionItem.id, itemId));

            expect(row.productId).toBe(smallId);
            expect(row.unitPriceCents).toBe(1999);
        });

        it("marks a change for the end of the period without moving money", async () => {
            const own = await makeSubscription();
            const itemId = own.items[0].id;

            const booked = await (
                await change(
                    bearer(
                        customerToken,
                        `https://virtify.test/api/v1/subscriptions/${own.id}/change`,
                        {
                            item_id: itemId,
                            product_id: "vps-l",
                            effective: "period_end",
                        },
                    ),
                    params(own.id),
                )
            ).json();

            expect(booked.applied_now).toBe(false);
            expect(booked.invoice_id).toBeNull();
            expect(booked.credited_cents).toBe(0);
            expect(booked.subscription.pending_changes).toHaveLength(1);
            expect(booked.subscription.items[0].product_id).toBe(smallId);
        });

        it("refuses a position of another Abo with 409", async () => {
            const a = await makeSubscription();
            const b = await makeSubscription();

            const response = await change(
                bearer(
                    staffToken,
                    `https://virtify.test/api/v1/subscriptions/${a.id}/change`,
                    { item_id: b.items[0].id, product_id: "vps-l" },
                ),
                params(a.id),
            );

            expect(response.status).toBe(409);
        });

        it("refuses a preview with no position named", async () => {
            const own = await makeSubscription();

            const response = await preview(
                bearer(
                    customerToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/preview-change`,
                ),
                params(own.id),
            );

            expect(response.status).toBe(422);
        });

        it("needs only `subscriptions.read` to preview", async () => {
            const own = await makeSubscription();

            const response = await preview(
                bearer(
                    readOnlyToken,
                    `https://virtify.test/api/v1/subscriptions/${own.id}/preview-change?item_id=${own.items[0].id}&product_id=vps-l`,
                ),
                params(own.id),
            );

            expect(response.status).toBe(200);
        });
    });

    describe("without a key", () => {
        it("answers 401 everywhere", async () => {
            const own = await makeSubscription();
            const url = `https://virtify.test/api/v1/subscriptions/${own.id}`;

            const responses = await Promise.all([
                list(new Request("https://virtify.test/api/v1/subscriptions")),
                read(new Request(url), params(own.id)),
                cancel(
                    new Request(`${url}/cancel`, { method: "POST" }),
                    params(own.id),
                ),
                pause(
                    new Request(`${url}/pause`, { method: "POST" }),
                    params(own.id),
                ),
                resume(
                    new Request(`${url}/resume`, { method: "POST" }),
                    params(own.id),
                ),
                change(
                    new Request(`${url}/change`, { method: "POST" }),
                    params(own.id),
                ),
                preview(new Request(`${url}/preview-change`), params(own.id)),
            ]);

            for (const response of responses) {
                expect(response.status).toBe(401);
            }
        });
    });
});
