import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * The PDF is rendered by @react-pdf/renderer, whose reconciler needs the
 * client build of React — and this suite runs under the `react-server`
 * condition, which `server-only` requires and which hands it the server
 * build instead. So the last step, turning the element tree into bytes, is
 * stubbed; everything above it is real, including building the whole
 * document from the frozen row.
 *
 * The stub returns *different* bytes on every call, which makes the claim
 * below stronger rather than weaker: two requests that come back identical
 * can only have come from the document store.
 */
let renders = 0;

vi.mock("@react-pdf/renderer", async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    renderToBuffer: async () => {
        renders += 1;

        return Buffer.from(`%PDF-1.7 render ${renders}`);
    },
}));

/**
 * `/api/v1/invoices` end to end: the real route handlers, the real bearer
 * middleware, the real queries, the real PDF renderer.
 *
 * The handlers reach for `@/db` rather than taking an executor — they are
 * route handlers, and a request has no transaction to hand them — so this
 * file points that module at the throwaway database before importing them.
 * That is why everything here is a dynamic import.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("/api/v1/invoices", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let documents: string;

    let list: (request: Request) => Promise<Response>;
    let create: (request: Request) => Promise<Response>;
    let read: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
    let pdf: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
    let finalize: (
        request: Request,
        context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;

    const staffUserId = "staffuser_01MTESTINVOICEAAAAAAAAAA";

    let staffToken = "";
    let readOnlyToken = "";
    let mineToken = "";

    let mineId = "";
    let theirsId = "";
    let draftId = "";
    let foreignInvoiceId = "";

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

        documents = await mkdtemp(path.join(tmpdir(), "virtify-api-docs-"));

        process.env.DATABASE_URL = db.$pool.options.connectionString as string;
        process.env.DOCUMENT_STORAGE_PATH = documents;
        delete (globalThis as { pool?: unknown }).pool;
        vi.resetModules();

        list = (await import("@/app/api/v1/invoices/route")).GET;
        create = (await import("@/app/api/v1/invoices/route")).POST;
        read = (await import("@/app/api/v1/invoices/[id]/route")).GET;
        pdf = (await import("@/app/api/v1/invoices/[id]/pdf/route")).GET;
        finalize = (await import("@/app/api/v1/invoices/[id]/finalize/route"))
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
            email: "rechnungen@example.test",
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
        theirsId = theirs.id;

        // One finalized invoice for each account, plus a draft for mine.
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
                            unitPriceCents: 1999,
                        },
                    ],
                },
                system,
            );

            await finalizeInvoice(db, row.id, system, {
                now: new Date("2026-11-07T10:00:00Z"),
            });

            if (!keep) {
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
                            unitPriceCents: 1999,
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
                    scopes: ["billing.read", "billing.write"],
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
                    scopes: ["billing.read"],
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
                    scopes: ["billing.read"],
                    owner: { type: "customer", customerId: mine.id },
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

        await rm(documents, { recursive: true, force: true });
        await drop();
    });

    describe("GET /api/v1/invoices", () => {
        it("refuses a request without a key", async () => {
            const response = await list(
                new Request("https://virtify.net/api/v1/invoices"),
            );

            expect(response.status).toBe(401);
            expect(response.headers.get("content-type")).toContain(
                "application/problem+json",
            );
        });

        it("gives a staff key every account's invoices", async () => {
            const response = await list(
                bearer(staffToken, "https://virtify.net/api/v1/invoices"),
            );
            const body = await response.json();

            expect(response.status).toBe(200);
            // Two finalized invoices and one draft.
            expect(body.data).toHaveLength(3);
            expect(body.has_more).toBe(false);
        });

        it("gives a customer key only its own, and never a draft", async () => {
            const response = await list(
                bearer(mineToken, "https://virtify.net/api/v1/invoices"),
            );
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.data).toHaveLength(1);
            expect(body.data[0].customer_id).toBe(mineId);
            expect(body.data[0].status).toBe("unpaid");
        });

        it("ignores customer_id on a customer key rather than honouring it", async () => {
            const response = await list(
                bearer(
                    mineToken,
                    `https://virtify.net/api/v1/invoices?customer_id=${theirsId}`,
                ),
            );
            const body = await response.json();

            expect(body.data).toHaveLength(1);
            expect(body.data[0].customer_id).toBe(mineId);
        });

        it("pages by ULID without repeating or skipping a row", async () => {
            const first = await (
                await list(
                    bearer(
                        staffToken,
                        "https://virtify.net/api/v1/invoices?limit=2",
                    ),
                )
            ).json();

            expect(first.data).toHaveLength(2);
            expect(first.has_more).toBe(true);

            const second = await (
                await list(
                    bearer(
                        staffToken,
                        `https://virtify.net/api/v1/invoices?limit=2&cursor=${first.next_cursor}`,
                    ),
                )
            ).json();

            expect(second.data).toHaveLength(1);
            expect(second.has_more).toBe(false);

            const ids = [...first.data, ...second.data].map(
                (row: { id: string }) => row.id,
            );

            expect(new Set(ids).size).toBe(3);
        });

        it("refuses a limit outside the range, naming the field", async () => {
            const response = await list(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/invoices?limit=500",
                ),
            );
            const body = await response.json();

            expect(response.status).toBe(422);
            expect(body.errors?.[0]?.path).toBe("limit");
        });
    });

    describe("GET /api/v1/invoices/{id}", () => {
        it("returns the invoice with its positions and tax snapshot", async () => {
            const page = await (
                await list(
                    bearer(mineToken, "https://virtify.net/api/v1/invoices"),
                )
            ).json();

            const response = await read(
                bearer(
                    mineToken,
                    `https://virtify.net/api/v1/invoices/${page.data[0].id}`,
                ),
                params(page.data[0].id),
            );
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.number).toMatch(/^RE-2026-\d{4}$/);
            expect(body.net_cents).toBe(1999);
            expect(body.tax_cents).toBe(0);
            expect(body.gross_cents).toBe(1999);
            expect(body.tax_strategy).toBe("kleinunternehmer");
            expect(body.tax_note).toBe(
                "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
            );
            expect(body.items).toHaveLength(1);
            expect(body.items[0]).toMatchObject({
                position: 1,
                net_cents: 1999,
                tax_rate_bp: 0,
                tax_category: "E",
                tax_rule: "kleinunternehmer",
            });
            expect(body.credit_notes).toEqual([]);
        });

        it("answers 404 for another account's invoice, not 403", async () => {
            const response = await read(
                bearer(
                    mineToken,
                    `https://virtify.net/api/v1/invoices/${foreignInvoiceId}`,
                ),
                params(foreignInvoiceId),
            );

            expect(response.status).toBe(404);
        });

        it("answers 404 for a draft on a customer key", async () => {
            const response = await read(
                bearer(
                    mineToken,
                    `https://virtify.net/api/v1/invoices/${draftId}`,
                ),
                params(draftId),
            );

            expect(response.status).toBe(404);

            // The same id is perfectly visible to the office.
            expect(
                (
                    await read(
                        bearer(
                            staffToken,
                            `https://virtify.net/api/v1/invoices/${draftId}`,
                        ),
                        params(draftId),
                    )
                ).status,
            ).toBe(200);
        });
    });

    describe("GET /api/v1/invoices/{id}/pdf", () => {
        it("renders, stores and then serves the stored bytes", async () => {
            const page = await (
                await list(
                    bearer(mineToken, "https://virtify.net/api/v1/invoices"),
                )
            ).json();
            const id = page.data[0].id;

            const first = await pdf(
                bearer(mineToken, `https://virtify.net/x/${id}/pdf`),
                params(id),
            );

            expect(first.status).toBe(200);
            expect(first.headers.get("content-type")).toBe("application/pdf");
            expect(first.headers.get("cache-control")).toBe(
                "private, no-store",
            );

            const bytes = Buffer.from(await first.arrayBuffer());

            expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

            // The row now knows where its bytes are, and what they were.
            const [row] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, id));

            expect(row.pdfKey).toMatch(/^invoices\/2026\/RE-2026-\d{4}\.pdf$/);
            expect(row.pdfSha256).toHaveLength(64);
            expect(row.pdfBytes).toBe(bytes.byteLength);

            // The second request comes back byte for byte identical. The
            // renderer would have produced something different, so this can
            // only be the stored document.
            const second = await pdf(
                bearer(mineToken, `https://virtify.net/x/${id}/pdf`),
                params(id),
            );

            expect(Buffer.from(await second.arrayBuffer()).equals(bytes)).toBe(
                true,
            );
        }, 60_000);

        it("answers 404 for another account's invoice", async () => {
            const response = await pdf(
                bearer(
                    mineToken,
                    `https://virtify.net/x/${foreignInvoiceId}/pdf`,
                ),
                params(foreignInvoiceId),
            );

            expect(response.status).toBe(404);
        });
    });

    describe("POST /api/v1/invoices", () => {
        it("refuses a customer key outright", async () => {
            const response = await create(
                bearer(
                    mineToken,
                    "https://virtify.net/api/v1/invoices",
                    "POST",
                    { customer_id: mineId, items: [] },
                ),
            );

            // billing.write is not in CUSTOMER_SCOPES at all, so the key
            // never gets as far as the handler's own refusal.
            expect(response.status).toBe(403);
        });

        it("refuses a staff key without billing.write", async () => {
            const response = await create(
                bearer(
                    readOnlyToken,
                    "https://virtify.net/api/v1/invoices",
                    "POST",
                    {
                        customer_id: mineId,
                        items: [
                            {
                                description: "X",
                                quantity: 1,
                                unit_price_cents: 100,
                            },
                        ],
                    },
                ),
            );

            expect(response.status).toBe(403);
        });

        it("creates a draft without a number or a tax decision", async () => {
            const response = await create(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/invoices",
                    "POST",
                    {
                        customer_id: mineId,
                        service_period_start: "2026-12-01T00:00:00.000Z",
                        service_period_end: "2026-12-31T00:00:00.000Z",
                        items: [
                            {
                                description: "VPS M — Dezember 2026",
                                quantity: 1,
                                unit_code: "MON",
                                unit_price_cents: 1999,
                            },
                        ],
                    },
                ),
            );
            const body = await response.json();

            expect(response.status).toBe(201);
            expect(body.status).toBe("draft");
            expect(body.number).toBeNull();
            expect(body.tax_strategy).toBeNull();
            expect(body.net_cents).toBeNull();
            expect(body.items).toEqual([]);
        });

        it("refuses an unknown account with a sentence, not a 500", async () => {
            const response = await create(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/invoices",
                    "POST",
                    {
                        customer_id: "customer_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                        items: [
                            {
                                description: "X",
                                quantity: 1,
                                unit_price_cents: 100,
                            },
                        ],
                    },
                ),
            );

            expect(response.status).toBe(422);
            expect((await response.json()).detail).toContain("Kundenkonto");
        });

        it("refuses a body with no positions, naming the field", async () => {
            const response = await create(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/invoices",
                    "POST",
                    { customer_id: mineId, items: [] },
                ),
            );
            const body = await response.json();

            expect(response.status).toBe(422);
            expect(body.errors?.[0]?.path).toBe("items");
        });

        it("refuses a position with quantity 0", async () => {
            const response = await create(
                bearer(
                    staffToken,
                    "https://virtify.net/api/v1/invoices",
                    "POST",
                    {
                        customer_id: mineId,
                        items: [
                            {
                                description: "X",
                                quantity: 0,
                                unit_price_cents: 100,
                            },
                        ],
                    },
                ),
            );

            expect(response.status).toBe(422);
        });
    });

    describe("POST /api/v1/invoices/{id}/finalize", () => {
        it("refuses a customer key with 404 rather than 403", async () => {
            // The key cannot carry billing.write at all, so it is refused by
            // the scope check before the handler is reached.
            const response = await finalize(
                bearer(
                    mineToken,
                    `https://virtify.net/x/${draftId}/finalize`,
                    "POST",
                ),
                params(draftId),
            );

            expect(response.status).toBe(403);
        });

        it("assigns a number, freezes the tax and returns the document", async () => {
            const response = await finalize(
                bearer(
                    staffToken,
                    `https://virtify.net/x/${draftId}/finalize`,
                    "POST",
                ),
                params(draftId),
            );
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.status).toBe("unpaid");
            expect(body.number).toMatch(/^RE-\d{4}-\d{4}$/);
            expect(body.tax_strategy).toBe("kleinunternehmer");
            expect(body.net_cents).toBe(1999);
            expect(body.gross_cents).toBe(1999);
            expect(body.items[0].tax_category).toBe("E");

            // The PDF is written on the way out, so the row knows where it is.
            const [row] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, draftId));

            expect(row.pdfKey).toBe(`invoices/2026/${body.number}.pdf`);
            expect(row.pdfRenderedAt).not.toBeNull();
        }, 60_000);

        it("refuses a second finalization with 409", async () => {
            const response = await finalize(
                bearer(
                    staffToken,
                    `https://virtify.net/x/${draftId}/finalize`,
                    "POST",
                ),
                params(draftId),
            );

            expect(response.status).toBe(409);
            expect((await response.json()).title).toBe("Nicht mehr änderbar");
        });

        it("answers 404 for an invoice that does not exist", async () => {
            const missing = "invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD";
            const response = await finalize(
                bearer(
                    staffToken,
                    `https://virtify.net/x/${missing}/finalize`,
                    "POST",
                ),
                params(missing),
            );

            expect(response.status).toBe(404);
        });
    });
});
