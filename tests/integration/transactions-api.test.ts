import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * `GET /api/v1/transactions` and `POST /api/v1/invoices/{id}/payments`, end
 * to end: the real route handlers, the real bearer middleware, the real
 * queries.
 *
 * The handlers reach for `@/db` rather than taking an executor — they are
 * route handlers, and a request has no transaction to hand them — so this
 * file points that module at the throwaway database before importing them.
 * That is why everything here is a dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("the payments API", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    let list: (request: Request) => Promise<Response>;
    let record: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;

    const staffUserId = "staffuser_01MTESTPAYMENTSAAAAAAAAA";

    let staffToken = "";
    let readOnlyToken = "";
    let mineToken = "";

    let mineId = "";
    let theirId = "";
    let myInvoiceId = "";
    let foreignInvoiceId = "";
    let draftId = "";

    const bearer = (
        token: string,
        url: string,
        method = "GET",
        body?: unknown,
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

        list = (await import("@/app/api/v1/transactions/route")).GET;
        record = (await import("@/app/api/v1/invoices/[id]/payments/route"))
            .POST;

        const { createApiKey } = await import("@/server/api-keys");
        const { createCustomer } = await import(
            "@/server/customers/repository"
        );
        const { createInvoiceDraft, finalizeInvoice } = await import(
            "@/server/billing/invoices/service"
        );

        const system = { type: "system" as const };

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Verwaltung",
            email: "zahlungen@example.test",
            emailVerified: true,
        });

        const [role] = await db
            .insert(schema.staffRole)
            .values({ name: "Alles", permissions: ["*"] })
            .returning();

        await db
            .insert(schema.staffRoleAssignment)
            .values({ staffUserId, roleId: role.id });

        const mine = await createCustomer(
            db,
            {
                kind: "private",
                name: "Tobias Weber",
                country: "DE",
                street: "Musterweg 1",
                postalCode: "12345",
                city: "Musterstadt",
                currency: "EUR",
                language: "de",
                status: "active",
            },
            system,
        );

        const theirs = await createCustomer(
            db,
            {
                kind: "private",
                name: "Jemand Anders",
                country: "DE",
                street: "Anderweg 2",
                postalCode: "54321",
                city: "Anderstadt",
                currency: "EUR",
                language: "de",
                status: "active",
            },
            system,
        );

        mineId = mine.id;
        theirId = theirs.id;

        for (const [customerId, keep] of [
            [mine.id, true],
            [theirs.id, false],
        ] as const) {
            const row = await createInvoiceDraft(
                db,
                {
                    customerId,
                    items: [
                        {
                            description: "VPS M — Oktober 2026",
                            quantity: 1,
                            unitCode: "MON",
                            unitPriceCents: 2999,
                        },
                    ],
                },
                system,
            );

            await finalizeInvoice(db, row.id, system, {
                now: new Date("2026-11-07T10:00:00Z"),
            });

            if (keep) {
                myInvoiceId = row.id;
            } else {
                foreignInvoiceId = row.id;
            }
        }

        draftId = (
            await createInvoiceDraft(
                db,
                {
                    customerId: mine.id,
                    items: [
                        {
                            description: "VPS M — November 2026",
                            quantity: 1,
                            unitCode: "MON",
                            unitPriceCents: 2999,
                        },
                    ],
                },
                system,
            )
        ).id;

        staffToken = (
            await createApiKey(
                db,
                {
                    name: "Verwaltung",
                    scopes: ["payments.read", "payments.write"],
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
                    scopes: ["payments.read"],
                    owner: { type: "staff", staffUserId },
                },
                system,
            )
        ).token;

        mineToken = (
            await createApiKey(
                db,
                {
                    name: "Kundenschlüssel",
                    scopes: ["payments.read", "payments.write"],
                    owner: { type: "customer", customerId: mine.id },
                },
                system,
            )
        ).token;

        /**
         * A settled payment on the *other* account, so "a customer key is
         * pinned to its own account" has something it could wrongly see.
         * Without this the foreign account owns no payment row and an
         * unscoped query would come back empty too — which is how that test
         * came to pass with the pin removed.
         */
        const { applyPayment } = await import("@/server/payments/apply");

        await applyPayment(db as never, {
            ref: "kontoauszug-fremd-0001",
            gateway: "banktransfer",
            invoiceId: foreignInvoiceId,
            customerId: theirs.id,
            amountCents: 2999,
            actor: system,
        });
    }, 60_000);

    afterAll(async () => {
        const { db: appDb } = await import("@/db");

        await (
            appDb as unknown as { $client: { end(): Promise<void> } }
        ).$client.end();
        delete (globalThis as { pool?: unknown }).pool;

        await drop();
    });

    describe("POST /api/v1/invoices/{id}/payments", () => {
        it("refuses a request without a key", async () => {
            const response = await record(
                new Request("https://virtify.net/api/v1/invoices/x/payments", {
                    method: "POST",
                }),
                params("x"),
            );

            expect(response.status).toBe(401);
        });

        it("refuses a key that may only read", async () => {
            const response = await record(
                bearer(
                    readOnlyToken,
                    `https://virtify.net/api/v1/invoices/${myInvoiceId}/payments`,
                    "POST",
                    {
                        amount_cents: 1000,
                        idempotency_key: "nope-00000001",
                    },
                ),
                params(myInvoiceId),
            );

            expect(response.status).toBe(403);
        });

        it("a customer key never carries payments.write at all", async () => {
            // Money arriving is something the operator observes, not
            // something the payer declares, so `payments.write` is not in
            // CUSTOMER_SCOPES — a customer key is stripped of it when it is
            // authenticated, whatever the key was asked to contain. The 403
            // is about the key's reach and confirms nothing about the
            // invoice; the route's own `scopedCustomerId` check behind it
            // answers 404, and is there in case that list ever changes.
            const response = await record(
                bearer(
                    mineToken,
                    `https://virtify.net/api/v1/invoices/${myInvoiceId}/payments`,
                    "POST",
                    {
                        amount_cents: 1000,
                        idempotency_key: "customer-00000001",
                    },
                ),
                params(myInvoiceId),
            );

            expect(response.status).toBe(403);

            // And nothing was booked.
            const [row] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, myInvoiceId));

            expect(row.paidCents).toBe(0);
        });

        it("books a part payment and leaves the invoice open", async () => {
            const response = await record(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/invoices/${myInvoiceId}/payments`,
                    "POST",
                    {
                        amount_cents: 1000,
                        idempotency_key: "kontoauszug-2026-11-07-pos-1",
                        reference: "RE-2026-0001",
                    },
                ),
                params(myInvoiceId),
            );

            expect(response.status).toBe(201);

            const body = await response.json();

            expect(body).toMatchObject({
                gateway: "banktransfer",
                kind: "charge",
                status: "succeeded",
                amount_cents: 1000,
                invoice: {
                    status: "partial",
                    paid_cents: 1000,
                    outstanding_cents: 1999,
                    credited_to_balance_cents: 0,
                },
            });
        });

        it("the same idempotency key books once", async () => {
            const again = await record(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/invoices/${myInvoiceId}/payments`,
                    "POST",
                    {
                        amount_cents: 1000,
                        idempotency_key: "kontoauszug-2026-11-07-pos-1",
                    },
                ),
                params(myInvoiceId),
            );

            // 200, not 201, and the transaction that already exists.
            expect(again.status).toBe(200);

            const [row] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, myInvoiceId));

            expect(row.paidCents).toBe(1000);
            expect(row.status).toBe("partial");
        });

        it("an overpayment settles the invoice and credits the rest", async () => {
            const response = await record(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/invoices/${myInvoiceId}/payments`,
                    "POST",
                    {
                        amount_cents: 2500,
                        idempotency_key: "kontoauszug-2026-11-09-pos-4",
                    },
                ),
                params(myInvoiceId),
            );

            expect(response.status).toBe(201);

            const body = await response.json();

            expect(body.invoice).toMatchObject({
                status: "paid",
                paid_cents: 2999,
                outstanding_cents: 0,
                // 1000 + 2500 against 2999 owed.
                credited_to_balance_cents: 501,
            });
        });

        it("refuses a second payment on a settled invoice", async () => {
            const response = await record(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/invoices/${myInvoiceId}/payments`,
                    "POST",
                    {
                        amount_cents: 100,
                        idempotency_key: "kontoauszug-2026-11-10-pos-9",
                    },
                ),
                params(myInvoiceId),
            );

            // Not silently credited: money for an invoice that wanted none is
            // a decision somebody has to make.
            expect(response.status).toBe(409);
            expect(response.headers.get("content-type")).toContain(
                "application/problem+json",
            );
        });

        it("refuses a draft", async () => {
            const response = await record(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/invoices/${draftId}/payments`,
                    "POST",
                    {
                        amount_cents: 100,
                        idempotency_key: "entwurf-00000001",
                    },
                ),
                params(draftId),
            );

            expect(response.status).toBe(422);
        });

        it("answers an unknown invoice with 404", async () => {
            const response = await record(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/invoices/invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD/payments",
                    "POST",
                    {
                        amount_cents: 100,
                        idempotency_key: "unbekannt-00000001",
                    },
                ),
                params("invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD"),
            );

            expect(response.status).toBe(404);
        });

        it("refuses an amount that is not whole cents", async () => {
            const response = await record(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/invoices/${foreignInvoiceId}/payments`,
                    "POST",
                    {
                        amount_cents: 19.99,
                        idempotency_key: "bruch-00000001",
                    },
                ),
                params(foreignInvoiceId),
            );

            expect(response.status).toBe(422);
        });

        it("refuses a missing idempotency key rather than risking a double booking", async () => {
            const response = await record(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/invoices/${foreignInvoiceId}/payments`,
                    "POST",
                    { amount_cents: 1000 },
                ),
                params(foreignInvoiceId),
            );

            expect(response.status).toBe(422);
        });
    });

    describe("GET /api/v1/transactions", () => {
        it("refuses a request without a key", async () => {
            const response = await list(
                new Request("https://virtify.net/api/v1/transactions"),
            );

            expect(response.status).toBe(401);
        });

        it("gives a staff key every account's transactions", async () => {
            const response = await list(
                bearer(staffToken, "https://virtify.net/api/v1/transactions"),
            );

            expect(response.status).toBe(200);

            const body = await response.json();

            expect(body.data.length).toBeGreaterThan(0);
            expect(body).toHaveProperty("next_cursor");
            expect(body).toHaveProperty("has_more");
        });

        it("pins a customer key to its own account", async () => {
            /**
             * This test used to ask for a ULID that matched no row, so the
             * answer was an empty page and the loop below never ran — and
             * the fixture booked payments only on one account, so even an
             * unscoped query could not have shown anything foreign. Both
             * halves are fixed here: the other account has a settled payment
             * of its own, the query names that account's real id, and the
             * page is asserted to be non-empty before it is inspected.
             *
             * Remove `scoped ??` from the route and this fails.
             */
            const theirs = await db
                .select({ id: schema.payment.id })
                .from(schema.payment)
                .where(eq(schema.payment.customerId, theirId));

            expect(theirs.length).toBeGreaterThan(0);

            const response = await list(
                bearer(
                    mineToken,
                    // The query asks for somebody else; the key wins.
                    `https://virtify.net/api/v1/transactions?customer_id=${theirId}`,
                ),
            );

            expect(response.status).toBe(200);

            const body = await response.json();

            expect(body.data.length).toBeGreaterThan(0);

            for (const row of body.data) {
                expect(row.customer_id).toBe(mineId);
            }
        });

        it("filters by invoice", async () => {
            const response = await list(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/transactions?invoice_id=${myInvoiceId}`,
                ),
            );

            const body = await response.json();

            expect(body.data.length).toBe(2);

            for (const row of body.data) {
                expect(row.invoice_id).toBe(myInvoiceId);
            }
        });

        it("pages on the ULID", async () => {
            const first = await list(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/transactions?limit=1",
                ),
            );

            const page = await first.json();

            expect(page.data).toHaveLength(1);
            expect(page.has_more).toBe(true);

            const next = await list(
                bearer(
                    staffToken,
                    `https://virtify.net/api/v1/transactions?limit=1&cursor=${page.next_cursor}`,
                ),
            );

            const second = await next.json();

            expect(second.data[0].id).not.toBe(page.data[0].id);
            expect(second.data[0].id > page.data[0].id).toBe(true);
        });

        it("refuses a limit outside the range", async () => {
            const response = await list(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/transactions?limit=500",
                ),
            );

            expect(response.status).toBe(422);
        });
    });
});
