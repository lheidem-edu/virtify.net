import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createId } from "@/lib/ulid";
import { loadInvoice } from "@/server/billing/invoices/repository";
import {
    createCreditNote,
    createInvoiceDraft,
    finalizeInvoice,
    InvoiceError,
    markInvoicePaid,
    updateInvoiceDraft,
} from "@/server/billing/invoices/service";
import { netRevenueForYear, thresholdStatus } from "@/server/billing/revenue";
import { defaultSettings, type Settings } from "@/server/settings";
import { scheduleTaxMode, taxModeAt } from "@/server/tax/mode";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * The invoicing engine, against a real Postgres.
 *
 * Everything here is a claim about what the database does — gapless numbers
 * under concurrency, a trigger that refuses an UPDATE, a strategy resolved by
 * a date — and none of it can be proved against a stub.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the invoicing, numbering and\n" +
            "        immutability proofs are being SKIPPED. Run `npm run db:up`.\n",
    );
}

const ACTOR = { type: "system" as const, label: "test" };

/**
 * Drizzle wraps a query failure in an error of its own and puts the server's
 * message on `cause`, so a plain `rejects.toThrow(/…/)` would only ever see
 * "Failed query: update …". The trigger's own sentence is what these tests
 * are about, so it is unwrapped here.
 */
async function expectRefused(work: Promise<unknown>, pattern: RegExp) {
    let message: string | null = null;

    try {
        await work;
    } catch (error) {
        const cause = (error as { cause?: { message?: string } })?.cause;
        message = cause?.message ?? (error as Error).message;
    }

    expect(
        message,
        "the database accepted a write it should have refused",
    ).toMatch(pattern);
}

/** Settings passed in rather than loaded, so no cache and no environment. */
const SETTINGS: Settings = {
    ...defaultSettings,
    operator: {
        ...defaultSettings.operator,
        country: "DE",
        taxNumber: "305/5721/1234",
    },
};

describe.skipIf(!available)("the invoicing engine", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let customerId: string;
    let austrianCompanyId: string;
    let austrianPersonId: string;
    let americanId: string;

    async function customer(
        over: Partial<typeof schema.customer.$inferInsert> & {
            customerNumber: number;
        },
    ) {
        const userId = createId("user");

        await db.insert(schema.user).values({
            id: userId,
            name: `Kunde ${over.customerNumber}`,
            email: `kunde${over.customerNumber}@example.test`,
            emailVerified: true,
        });

        const [row] = await db
            .insert(schema.customer)
            .values({
                name: `Kunde ${over.customerNumber}`,
                country: "DE",
                street: "Musterweg 1",
                postalCode: "12345",
                city: "Musterstadt",
                ...over,
            })
            .returning();

        await db.insert(schema.customerContact).values({
            customerId: row.id,
            userId,
            role: "owner",
            email: `kunde${over.customerNumber}@example.test`,
        });

        return row.id;
    }

    async function draft(
        owner = customerId,
        items = [
            {
                description: "VPS M — Oktober 2026",
                quantity: 1,
                unitCode: "MON",
                unitPriceCents: 1999,
            },
        ],
    ) {
        return createInvoiceDraft(db, { customerId: owner, items }, ACTOR);
    }

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        customerId = await customer({ customerNumber: 10_001 });
        austrianCompanyId = await customer({
            customerNumber: 10_002,
            country: "AT",
            kind: "company",
            vatId: "ATU12345678",
            vatIdValidatedAt: new Date("2026-01-01T00:00:00Z"),
        });
        austrianPersonId = await customer({
            customerNumber: 10_003,
            country: "AT",
            kind: "private",
        });
        americanId = await customer({
            customerNumber: 10_004,
            country: "US",
            kind: "company",
        });
    });

    afterAll(async () => {
        await drop();
    });

    beforeEach(async () => {
        // Each test starts from the § 19 default; the switch test adds a row.
        await db
            .delete(schema.taxModeHistory)
            .where(sql`${schema.taxModeHistory.effectiveFrom} > '1970-01-02'`);
    });

    describe("finalizing", () => {
        it("assigns a gapless number and freezes the document", async () => {
            const row = await draft();
            const at = new Date("2026-11-07T10:00:00Z");

            const { invoice, totals } = await finalizeInvoice(
                db,
                row.id,
                ACTOR,
                { now: at, settings: SETTINGS, paymentTermDays: 14 },
            );

            expect(invoice.number).toMatch(/^RE-2026-\d{4}$/);
            expect(invoice.status).toBe("unpaid");
            expect(invoice.issuedAt?.toISOString()).toBe(at.toISOString());
            expect(invoice.dueAt?.toISOString()).toBe(
                "2026-11-21T10:00:00.000Z",
            );

            // § 19 UStG: 0 %, category E, gross equals net.
            expect(invoice.taxStrategy).toBe("kleinunternehmer");
            expect(invoice.taxNote).toBe(
                "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
            );
            expect(invoice.netCents).toBe(1999);
            expect(invoice.taxCents).toBe(0);
            expect(invoice.grossCents).toBe(1999);
            expect(totals.grossCents).toBe(1999);

            // The parties, frozen.
            expect(invoice.buyerName).toBe("Kunde 10001");
            expect(invoice.buyerCustomerNumber).toBe(10_001);
            expect(invoice.recipient).toContain("Musterweg 1");
            expect(invoice.sellerName).toBe(SETTINGS.operator.name);
            expect(invoice.sellerTaxNumber).toBe("305/5721/1234");
            expect(invoice.sellerIban).toBe(SETTINGS.bank.iban);

            const [item] = await db
                .select()
                .from(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, row.id));

            expect(item.taxStrategy).toBe("kleinunternehmer");
            expect(item.taxRateBp).toBe(0);
            expect(item.taxCategory).toBe("E");
            expect(item.taxRule).toBe("kleinunternehmer");
            expect(item.netCents).toBe(1999);
        });

        it("writes an audit entry naming the strategy and the rate", async () => {
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            const [entry] = await db
                .select()
                .from(schema.auditLog)
                .where(eq(schema.auditLog.entityId, row.id))
                .orderBy(sql`${schema.auditLog.createdAt} desc`)
                .limit(1);

            expect(entry.action).toBe("invoice.finalize");
            expect(entry.after).toMatchObject({
                status: "unpaid",
                taxStrategy: "kleinunternehmer",
                taxRule: "kleinunternehmer",
                taxRateBp: 0,
            });
        });

        it("shows a draft the tax it would be issued with today", async () => {
            // A draft carries no snapshot — tax is decided at finalization —
            // so what it shows has to come from the strategy in force now.
            // Otherwise a draft that is about to be issued with 19 % would
            // read as one with none.
            const row = await draft();

            const under19 = await loadInvoice(row.id, "", true, db);

            expect(under19?.invoice.taxStrategy).toBeNull();
            expect(under19?.effectiveTaxStrategy).toBe("kleinunternehmer");
            expect(under19?.totals.taxCents).toBe(0);
            expect(under19?.taxNotes).toEqual([
                "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
            ]);

            // Switch to regular VAT with immediate effect: the same draft,
            // untouched, now shows what issuing it would actually charge.
            await scheduleTaxMode(
                db,
                { strategy: "regular-vat", effectiveFrom: new Date() },
                ACTOR,
            );

            const underVat = await loadInvoice(row.id, "", true, db);

            expect(underVat?.invoice.taxStrategy).toBeNull();
            expect(underVat?.effectiveTaxStrategy).toBe("regular-vat");
            expect(underVat?.totals.taxCents).toBe(380);
            expect(underVat?.totals.grossCents).toBe(2379);
            expect(underVat?.taxNotes).toEqual([]);
        });

        it("refuses a second finalization", async () => {
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            await expect(
                finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS }),
            ).rejects.toThrow(InvoiceError);
        });

        it("refuses an invoice with no positions", async () => {
            const [row] = await db
                .insert(schema.invoice)
                .values({ customerId, status: "draft" })
                .returning();

            await expect(
                finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS }),
            ).rejects.toThrow(/ohne Positionen/);
        });

        it("burns no number when the finalization fails", async () => {
            const before = await counter();

            const [row] = await db
                .insert(schema.invoice)
                .values({ customerId, status: "draft" })
                .returning();

            await expect(
                finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS }),
            ).rejects.toThrow();

            expect(await counter()).toBe(before);
        });
    });

    describe("gapless numbering under concurrency", () => {
        it("gives twenty parallel finalizations 1..20, no gap, no duplicate", async () => {
            const fresh = await createTestDatabase();

            try {
                const owner = await (async () => {
                    const userId = createId("user");
                    await fresh.db.insert(schema.user).values({
                        id: userId,
                        name: "Parallel",
                        email: "parallel@example.test",
                        emailVerified: true,
                    });
                    const [row] = await fresh.db
                        .insert(schema.customer)
                        .values({
                            customerNumber: 20_001,
                            name: "Parallel",
                            country: "DE",
                            street: "Musterweg 1",
                            postalCode: "12345",
                            city: "Musterstadt",
                        })
                        .returning();
                    await fresh.db.insert(schema.customerContact).values({
                        customerId: row.id,
                        userId,
                        role: "owner",
                        email: "parallel@example.test",
                    });
                    return row.id;
                })();

                const drafts = await Promise.all(
                    Array.from({ length: 20 }, (_, index) =>
                        createInvoiceDraft(
                            fresh.db,
                            {
                                customerId: owner,
                                items: [
                                    {
                                        description: `Position ${index}`,
                                        quantity: 1,
                                        unitCode: "MON",
                                        unitPriceCents: 100 + index,
                                    },
                                ],
                            },
                            ACTOR,
                        ),
                    ),
                );

                // All twenty at once, each in its own transaction on its own
                // connection: the counter's row lock is the only thing
                // serialising them.
                const results = await Promise.all(
                    drafts.map((row) =>
                        finalizeInvoice(fresh.db, row.id, ACTOR, {
                            now: new Date("2026-11-07T10:00:00Z"),
                            settings: SETTINGS,
                        }),
                    ),
                );

                const numbers = results
                    .map((result) => result.number)
                    .sort((a, b) => a.localeCompare(b));

                expect(numbers).toEqual(
                    Array.from(
                        { length: 20 },
                        (_, index) =>
                            `RE-2026-${String(index + 1).padStart(4, "0")}`,
                    ),
                );
                expect(new Set(numbers).size).toBe(20);
            } finally {
                await fresh.drop();
            }
        }, 60_000);
    });

    describe("the immutability trigger", () => {
        it("refuses an UPDATE of a finalized invoice", async () => {
            const row = await draft();
            const { invoice } = await finalizeInvoice(db, row.id, ACTOR, {
                settings: SETTINGS,
            });

            await expectRefused(
                db
                    .update(schema.invoice)
                    .set({ netCents: 1 })
                    .where(eq(schema.invoice.id, invoice.id)),
                /ausgestellt und darf nicht mehr geändert/,
            );

            await expectRefused(
                db
                    .update(schema.invoice)
                    .set({ number: "RE-2026-9999" })
                    .where(eq(schema.invoice.id, invoice.id)),
                /ausgestellt und darf nicht mehr geändert/,
            );
        });

        it("still lets the payment state and the stored PDF through", async () => {
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            await db
                .update(schema.invoice)
                .set({ status: "paid", paidAt: new Date() })
                .where(eq(schema.invoice.id, row.id));

            await db
                .update(schema.invoice)
                .set({ pdfKey: "invoices/2026/x.pdf", pdfSha256: "abc" })
                .where(eq(schema.invoice.id, row.id));

            // …but only once. The bytes of a finalized document are the
            // document; swapping them is not a state change.
            await expectRefused(
                db
                    .update(schema.invoice)
                    .set({ pdfKey: "invoices/2026/y.pdf" })
                    .where(eq(schema.invoice.id, row.id)),
                /darf nicht ersetzt werden/,
            );
        });

        it("refuses a DELETE of a finalized invoice but allows a draft", async () => {
            const keep = await draft();
            await finalizeInvoice(db, keep.id, ACTOR, { settings: SETTINGS });

            await expectRefused(
                db.delete(schema.invoice).where(eq(schema.invoice.id, keep.id)),
                /§ 147 AO/,
            );

            const gone = await draft();
            await db
                .delete(schema.invoice)
                .where(eq(schema.invoice.id, gone.id));
        });

        it("refuses to touch the positions of a finalized invoice", async () => {
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            await expectRefused(
                db
                    .update(schema.invoiceItem)
                    .set({ quantity: 99 })
                    .where(eq(schema.invoiceItem.invoiceId, row.id)),
                /dürfen nicht geändert werden/,
            );

            await expectRefused(
                db
                    .delete(schema.invoiceItem)
                    .where(eq(schema.invoiceItem.invoiceId, row.id)),
                /dürfen nicht geändert werden/,
            );

            await expectRefused(
                db.insert(schema.invoiceItem).values({
                    invoiceId: row.id,
                    position: 99,
                    description: "Nachträglich",
                    quantity: 1,
                    unitPriceCents: 100,
                }),
                /dürfen nicht geändert werden/,
            );
        });

        /**
         * The whole point of putting rule 3 in the database as well is that
         * "a migration, a console, a later feature or a bug can all reach the
         * row directly". Against that caller it used to cost one extra
         * statement: `status` is mutable, so demoting a finalized invoice to
         * `draft` was accepted, and every other guard keys off the status.
         */
        it("refuses to turn a finalized invoice back into a draft", async () => {
            const row = await draft();
            const { invoice } = await finalizeInvoice(db, row.id, ACTOR, {
                settings: SETTINGS,
            });

            await expectRefused(
                db
                    .update(schema.invoice)
                    .set({ status: "draft" })
                    .where(eq(schema.invoice.id, invoice.id)),
                /kann kein Entwurf mehr werden/,
            );

            // …and so the two-statement way round every other guard is shut:
            // the number, the totals and the positions all stay.
            await expectRefused(
                db
                    .update(schema.invoice)
                    .set({ status: "draft", netCents: 1 })
                    .where(eq(schema.invoice.id, invoice.id)),
                /kann kein Entwurf mehr werden/,
            );

            const [after] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoice.id));

            expect(after.status).toBe("unpaid");
            expect(after.number).toBe(invoice.number);
        });

        it("refuses to delete a numbered row whatever its status says", async () => {
            // A number is what § 14 Abs. 4 Nr. 4 UStG wants gapless, so a row
            // that has one is a document even when its status says draft.
            // INSERT is not guarded, so this is the state a bad migration or
            // a restore could leave behind — deleting it would punch a hole
            // in the RE- series.
            const id = createId("invoice");

            await db.insert(schema.invoice).values({
                id,
                customerId,
                status: "draft",
                number: "RE-2026-9001",
                netCents: 1000,
                grossCents: 1000,
                issuedAt: new Date(),
            });

            await expectRefused(
                db.delete(schema.invoice).where(eq(schema.invoice.id, id)),
                /§ 147 AO/,
            );

            // A genuine draft, with no number, still goes.
            const gone = await draft();
            await db
                .delete(schema.invoice)
                .where(eq(schema.invoice.id, gone.id));
        });

        it("refuses a line added to a credit note after the fact", async () => {
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            const credit = await createCreditNote(
                db,
                { invoiceId: row.id, kind: "full" },
                ACTOR,
                { settings: SETTINGS },
            );

            // The note's own totals are frozen and its PDF is written once,
            // but `loadCreditNote` recomputes the totals from these rows and
            // the XRechnung is rendered from that — so an added line made the
            // XML contradict the PDF the customer holds.
            await expectRefused(
                db.insert(schema.creditNoteItem).values({
                    creditNoteId: credit.id,
                    position: 99,
                    description: "Frei erfunden",
                    quantity: 1,
                    unitCode: "MON",
                    unitPriceCents: 999_999,
                    taxStrategy: "kleinunternehmer",
                    taxRateBp: 0,
                    taxCategory: "E",
                    taxRule: "kleinunternehmer",
                    netCents: 999_999,
                }),
                /dürfen nicht geändert werden/,
            );
        });

        it("refuses to edit a draft through the service once it is finalized", async () => {
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            await expect(
                updateInvoiceDraft(
                    db,
                    row.id,
                    {
                        customerId,
                        items: [
                            {
                                description: "Anders",
                                quantity: 1,
                                unitCode: "MON",
                                unitPriceCents: 1,
                            },
                        ],
                    },
                    ACTOR,
                ),
            ).rejects.toThrow(/Nur Entwürfe/);
        });
    });

    describe("the strategy switch", () => {
        it("applies by finalization date and never retroactively", async () => {
            const switchAt = new Date("2027-01-01T00:00:00Z");

            await scheduleTaxMode(
                db,
                { strategy: "regular-vat", effectiveFrom: switchAt },
                ACTOR,
                new Date("2026-11-07T10:00:00Z"),
            );

            expect(
                (await taxModeAt(db, new Date("2026-12-31T23:59:59Z")))
                    .strategy,
            ).toBe("kleinunternehmer");
            expect(
                (await taxModeAt(db, new Date("2027-01-01T00:00:01Z")))
                    .strategy,
            ).toBe("regular-vat");

            const before = await draft();
            const older = await finalizeInvoice(db, before.id, ACTOR, {
                now: new Date("2026-12-20T10:00:00Z"),
                settings: SETTINGS,
            });

            const after = await draft();
            const newer = await finalizeInvoice(db, after.id, ACTOR, {
                now: new Date("2027-02-01T10:00:00Z"),
                settings: SETTINGS,
            });

            // 19,99 € under § 19 and 19,99 € + 19 % = 23,79 € after the switch.
            expect(older.invoice.taxStrategy).toBe("kleinunternehmer");
            expect(older.invoice.taxCents).toBe(0);
            expect(older.invoice.grossCents).toBe(1999);

            expect(newer.invoice.taxStrategy).toBe("regular-vat");
            expect(newer.invoice.taxCents).toBe(380);
            expect(newer.invoice.grossCents).toBe(2379);

            // The older invoice is untouched by the switch, on the row and in
            // every line.
            const reloaded = await loadInvoice(before.id, "", true, db);

            expect(reloaded?.invoice.taxCents).toBe(0);
            expect(reloaded?.totals.grossCents).toBe(1999);
            expect(reloaded?.items[0].taxRateBp).toBe(0);
            expect(reloaded?.items[0].taxCategory).toBe("E");
        });

        it("refuses a switch dated into the past", async () => {
            await expect(
                scheduleTaxMode(
                    db,
                    {
                        strategy: "regular-vat",
                        effectiveFrom: new Date("2020-01-01T00:00:00Z"),
                    },
                    ACTOR,
                ),
            ).rejects.toThrow(/rückwirkend/);
        });

        it("taxes DE, AT-B2B, AT-B2C and US under regular VAT", async () => {
            await scheduleTaxMode(
                db,
                {
                    strategy: "regular-vat",
                    effectiveFrom: new Date("2027-01-01T00:00:00Z"),
                },
                ACTOR,
                new Date("2026-11-07T10:00:00Z"),
            );

            const at = new Date("2027-03-01T10:00:00Z");
            const money = 10_000;

            const cases = [
                {
                    owner: customerId,
                    tax: 1900,
                    gross: 11_900,
                    rule: "domestic-standard",
                    category: "S",
                },
                {
                    owner: austrianCompanyId,
                    tax: 0,
                    gross: 10_000,
                    rule: "eu-b2b-reverse-charge",
                    category: "AE",
                },
                {
                    owner: austrianPersonId,
                    tax: 2000,
                    gross: 12_000,
                    rule: "eu-b2c-oss",
                    category: "S",
                },
                {
                    owner: americanId,
                    tax: 0,
                    gross: 10_000,
                    rule: "non-eu-out-of-scope",
                    category: "O",
                },
            ];

            for (const expected of cases) {
                const row = await draft(expected.owner, [
                    {
                        description: "VPS L",
                        quantity: 1,
                        unitCode: "MON",
                        unitPriceCents: money,
                    },
                ]);

                const { invoice } = await finalizeInvoice(db, row.id, ACTOR, {
                    now: at,
                    settings: SETTINGS,
                });

                expect(invoice.netCents).toBe(money);
                expect(invoice.taxCents).toBe(expected.tax);
                expect(invoice.grossCents).toBe(expected.gross);

                const [item] = await db
                    .select()
                    .from(schema.invoiceItem)
                    .where(eq(schema.invoiceItem.invoiceId, row.id));

                expect(item.taxRule).toBe(expected.rule);
                expect(item.taxCategory).toBe(expected.category);
            }
        });

        it("refuses to finalize under regular VAT without a country", async () => {
            const nowhere = await customer({
                customerNumber: 10_009,
                country: null,
            });

            await scheduleTaxMode(
                db,
                {
                    strategy: "regular-vat",
                    effectiveFrom: new Date("2027-01-01T00:00:00Z"),
                },
                ACTOR,
                new Date("2026-11-07T10:00:00Z"),
            );

            const row = await draft(nowhere);

            await expect(
                finalizeInvoice(db, row.id, ACTOR, {
                    now: new Date("2027-03-01T10:00:00Z"),
                    settings: SETTINGS,
                }),
            ).rejects.toThrow(/Land des Kundenkontos/);

            // And the attempt took no number with it.
            const reloaded = await loadInvoice(row.id, "", true, db);
            expect(reloaded?.invoice.number).toBeNull();
            expect(reloaded?.invoice.status).toBe("draft");
        });
    });

    describe("credit notes", () => {
        it("reverses the whole invoice onto its own number range", async () => {
            const row = await draft();
            const { invoice } = await finalizeInvoice(db, row.id, ACTOR, {
                settings: SETTINGS,
            });

            const credit = await createCreditNote(
                db,
                { invoiceId: row.id, kind: "full", reason: "Falsch berechnet" },
                ACTOR,
                { settings: SETTINGS },
            );

            expect(credit.number).toMatch(/^RK-\d{4}-\d{4}$/);
            expect(credit.totals.netCents).toBe(invoice.netCents);
            expect(credit.totals.grossCents).toBe(invoice.grossCents);
            expect(credit.fullyCredited).toBe(true);

            const reloaded = await loadInvoice(row.id, "", true, db);

            expect(reloaded?.invoice.status).toBe("cancelled");
            expect(reloaded?.invoice.creditedCents).toBe(invoice.grossCents);
            expect(reloaded?.creditNotes).toHaveLength(1);

            // The correction carries the original's parties and its tax
            // snapshot, not whatever is in force or on file today.
            const [note] = await db
                .select()
                .from(schema.creditNote)
                .where(eq(schema.creditNote.invoiceId, row.id));

            expect(note.recipient).toBe(invoice.recipient);
            expect(note.taxStrategy).toBe("kleinunternehmer");
            expect(note.taxNote).toBe(invoice.taxNote);

            const [line] = await db
                .select()
                .from(schema.creditNoteItem)
                .where(eq(schema.creditNoteItem.creditNoteId, note.id));

            // Positive amounts: UNTDID 1001 type 381.
            expect(line.quantity).toBe(1);
            expect(line.unitPriceCents).toBe(1999);
            expect(line.netCents).toBe(1999);
        });

        it("credits part of an invoice and leaves the rest standing", async () => {
            const row = await draft(customerId, [
                {
                    description: "VPS M",
                    quantity: 3,
                    unitCode: "MON",
                    unitPriceCents: 1000,
                },
                {
                    description: "Einrichtung",
                    quantity: 1,
                    unitCode: "C62",
                    unitPriceCents: 500,
                },
            ]);

            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            const items = await db
                .select()
                .from(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, row.id))
                .orderBy(asc(schema.invoiceItem.position));

            const credit = await createCreditNote(
                db,
                {
                    invoiceId: row.id,
                    kind: "partial",
                    lines: [{ invoiceItemId: items[0].id, quantity: 1 }],
                },
                ACTOR,
                { settings: SETTINGS },
            );

            expect(credit.totals.grossCents).toBe(1000);
            expect(credit.fullyCredited).toBe(false);

            const reloaded = await loadInvoice(row.id, "", true, db);

            expect(reloaded?.invoice.status).toBe("unpaid");
            expect(reloaded?.invoice.creditedCents).toBe(1000);
            expect(reloaded?.invoice.grossCents).toBe(3500);
        });

        /**
         * The remaining quantity used to be recomputed from a snapshot taken
         * before the loop, so two entries naming the same position each saw
         * the whole remainder. A line that charged 10,00 € was credited
         * 20,00 €, and the document-level cap did not notice because a larger
         * line on the same invoice left room under the gross.
         */
        it("will not credit one position twice in a single correction", async () => {
            const row = await draft(customerId, [
                {
                    description: "Klein",
                    quantity: 1,
                    unitCode: "C62",
                    unitPriceCents: 1000,
                },
                {
                    description: "Groß",
                    quantity: 1,
                    unitCode: "C62",
                    unitPriceCents: 10_000,
                },
            ]);

            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            const items = await db
                .select()
                .from(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, row.id));
            const small = items.find(
                (item) => item.description === "Klein",
            ) as (typeof items)[number];

            await expect(
                createCreditNote(
                    db,
                    {
                        invoiceId: row.id,
                        kind: "partial",
                        lines: [
                            { invoiceItemId: small.id, quantity: 1 },
                            { invoiceItemId: small.id, quantity: 1 },
                        ],
                    },
                    ACTOR,
                    { settings: SETTINGS },
                ),
            ).rejects.toThrow(/bereits vollständig korrigiert/);

            const [after] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, row.id));

            expect(after.creditedCents).toBe(0);
        });

        /**
         * `POST /api/v1/invoices` accepts — and its OpenAPI description
         * advertises — a negative quantity for a deduction. Refusing that
         * sign in a correction left such an invoice permanently
         * uncancellable: a finalized row can be neither edited nor deleted,
         * and a credit note is the only way back.
         */
        it("reverses a deduction line as a deduction", async () => {
            const row = await draft(customerId, [
                {
                    description: "Webhosting M",
                    quantity: 2,
                    unitCode: "MON",
                    unitPriceCents: 1000,
                },
                {
                    description: "Gutschrift Ausfallzeit",
                    quantity: -1,
                    unitCode: "MON",
                    unitPriceCents: 1000,
                },
            ]);

            const { totals } = await finalizeInvoice(db, row.id, ACTOR, {
                settings: SETTINGS,
            });

            expect(totals.grossCents).toBe(1000);

            const credit = await createCreditNote(
                db,
                { invoiceId: row.id, kind: "full" },
                ACTOR,
                { settings: SETTINGS },
            );

            // The correction mirrors the invoice line for line, signs and
            // all, so the pair cancels to nothing.
            expect(credit.totals.grossCents).toBe(1000);
            expect(credit.fullyCredited).toBe(true);
            expect(
                credit.totals.lines.map((line) => line.quantity).sort(),
            ).toEqual([-1, 2]);

            const [after] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, row.id));

            expect(after.status).toBe("cancelled");
            expect(after.creditedCents).toBe(1000);
        });

        it("will not turn a deduction into a charge", async () => {
            const row = await draft(customerId, [
                {
                    description: "Rabatt",
                    quantity: -2,
                    unitCode: "C62",
                    unitPriceCents: 500,
                },
            ]);

            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            const [item] = await db
                .select()
                .from(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, row.id));

            await expect(
                createCreditNote(
                    db,
                    {
                        invoiceId: row.id,
                        kind: "partial",
                        lines: [{ invoiceItemId: item.id, quantity: 2 }],
                    },
                    ACTOR,
                    { settings: SETTINGS },
                ),
            ).rejects.toThrow(/höchstens -2/);

            await expect(
                createCreditNote(
                    db,
                    {
                        invoiceId: row.id,
                        kind: "partial",
                        lines: [{ invoiceItemId: item.id, quantity: -3 }],
                    },
                    ACTOR,
                    { settings: SETTINGS },
                ),
            ).rejects.toThrow(/höchstens -2/);
        });

        it("will not credit more than was charged", async () => {
            const row = await draft(customerId, [
                {
                    description: "VPS M",
                    quantity: 2,
                    unitCode: "MON",
                    unitPriceCents: 1000,
                },
            ]);

            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            const [item] = await db
                .select()
                .from(schema.invoiceItem)
                .where(eq(schema.invoiceItem.invoiceId, row.id));

            await expect(
                createCreditNote(
                    db,
                    {
                        invoiceId: row.id,
                        kind: "partial",
                        lines: [{ invoiceItemId: item.id, quantity: 3 }],
                    },
                    ACTOR,
                    { settings: SETTINGS },
                ),
            ).rejects.toThrow(/höchstens 2/);

            await createCreditNote(
                db,
                {
                    invoiceId: row.id,
                    kind: "partial",
                    lines: [{ invoiceItemId: item.id, quantity: 2 }],
                },
                ACTOR,
                { settings: SETTINGS },
            );

            // Now there is nothing left to take back.
            await expect(
                createCreditNote(
                    db,
                    { invoiceId: row.id, kind: "full" },
                    ACTOR,
                    { settings: SETTINGS },
                ),
            ).rejects.toThrow(/vollständig korrigiert/);
        });

        it("keeps the invoice's old rate after the strategy has moved on", async () => {
            // Finalized under § 19; the switch happens; the correction still
            // reverses 0 %, because it corrects *that* invoice.
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, {
                now: new Date("2026-12-01T10:00:00Z"),
                settings: SETTINGS,
            });

            await scheduleTaxMode(
                db,
                {
                    strategy: "regular-vat",
                    effectiveFrom: new Date("2027-01-01T00:00:00Z"),
                },
                ACTOR,
                new Date("2026-11-07T10:00:00Z"),
            );

            const credit = await createCreditNote(
                db,
                { invoiceId: row.id, kind: "full" },
                ACTOR,
                { now: new Date("2027-03-01T10:00:00Z"), settings: SETTINGS },
            );

            expect(credit.totals.taxCents).toBe(0);
            expect(credit.totals.grossCents).toBe(1999);

            const [note] = await db
                .select()
                .from(schema.creditNote)
                .where(eq(schema.creditNote.invoiceId, row.id));

            expect(note.taxStrategy).toBe("kleinunternehmer");
        });

        it("refuses to correct a draft", async () => {
            const row = await draft();

            await expect(
                createCreditNote(
                    db,
                    { invoiceId: row.id, kind: "full" },
                    ACTOR,
                    { settings: SETTINGS },
                ),
            ).rejects.toThrow(/Nur ausgestellte/);
        });

        it("is immutable and undeletable", async () => {
            const row = await draft();
            await finalizeInvoice(db, row.id, ACTOR, { settings: SETTINGS });

            const credit = await createCreditNote(
                db,
                { invoiceId: row.id, kind: "full" },
                ACTOR,
                { settings: SETTINGS },
            );

            await expectRefused(
                db
                    .update(schema.creditNote)
                    .set({ netCents: 1 })
                    .where(eq(schema.creditNote.id, credit.id)),
                /darf nicht geändert werden/,
            );

            await expectRefused(
                db
                    .delete(schema.creditNote)
                    .where(eq(schema.creditNote.id, credit.id)),
                /§ 147 AO/,
            );

            await expectRefused(
                db
                    .update(schema.creditNoteItem)
                    .set({ quantity: 99 })
                    .where(eq(schema.creditNoteItem.creditNoteId, credit.id)),
                /dürfen nicht geändert werden/,
            );
        });
    });

    describe("the § 19 threshold monitor", () => {
        it("counts paid invoices net, less what corrections took back", async () => {
            const fresh = await createTestDatabase();

            try {
                const userId = createId("user");
                await fresh.db.insert(schema.user).values({
                    id: userId,
                    name: "Umsatz",
                    email: "umsatz@example.test",
                    emailVerified: true,
                });
                const [owner] = await fresh.db
                    .insert(schema.customer)
                    .values({
                        customerNumber: 30_001,
                        name: "Umsatz",
                        country: "DE",
                        street: "Musterweg 1",
                        postalCode: "12345",
                        city: "Musterstadt",
                    })
                    .returning();
                await fresh.db.insert(schema.customerContact).values({
                    customerId: owner.id,
                    userId,
                    role: "owner",
                    email: "umsatz@example.test",
                });

                const service = new Date("2026-06-15T10:00:00Z");

                // Three invoices of 10 000,00 €: one paid, one unpaid, one
                // paid and then corrected in full.
                const made = [];

                for (let index = 0; index < 3; index++) {
                    const row = await createInvoiceDraft(
                        fresh.db,
                        {
                            customerId: owner.id,
                            servicePeriodStart: service,
                            servicePeriodEnd: service,
                            items: [
                                {
                                    description: `Jahr ${index}`,
                                    quantity: 1,
                                    unitCode: "ANN",
                                    unitPriceCents: 1_000_000,
                                },
                            ],
                        },
                        ACTOR,
                    );

                    await finalizeInvoice(fresh.db, row.id, ACTOR, {
                        now: service,
                        settings: SETTINGS,
                    });

                    made.push(row.id);
                }

                await markInvoicePaid(fresh.db, made[0], ACTOR, service);
                await markInvoicePaid(fresh.db, made[2], ACTOR, service);
                await createCreditNote(
                    fresh.db,
                    { invoiceId: made[2], kind: "full" },
                    ACTOR,
                    { now: service, settings: SETTINGS },
                );

                // Paid 20 000,00 €, corrected 10 000,00 € of it.
                expect(await netRevenueForYear(fresh.db, 2026, "service")).toBe(
                    1_000_000,
                );
                expect(await netRevenueForYear(fresh.db, 2025, "service")).toBe(
                    0,
                );

                const status = await thresholdStatus(
                    fresh.db,
                    SETTINGS,
                    new Date("2026-11-07T10:00:00Z"),
                );

                expect(status.current.netCents).toBe(1_000_000);
                expect(status.current.limitCents).toBe(10_000_000);
                expect(status.current.ratio).toBeCloseTo(0.1);
                expect(status.current.level).toBeNull();
                expect(status.previous.year).toBe(2025);
                expect(status.stillSmallBusiness).toBe(true);
            } finally {
                await fresh.drop();
            }
        }, 60_000);

        it("crosses 80 % and 100 % at exactly the right euro", async () => {
            const fresh = await createTestDatabase();

            try {
                const userId = createId("user");
                await fresh.db.insert(schema.user).values({
                    id: userId,
                    name: "Grenze",
                    email: "grenze@example.test",
                    emailVerified: true,
                });
                const [owner] = await fresh.db
                    .insert(schema.customer)
                    .values({
                        customerNumber: 40_001,
                        name: "Grenze",
                        country: "DE",
                        street: "Musterweg 1",
                        postalCode: "12345",
                        city: "Musterstadt",
                    })
                    .returning();
                await fresh.db.insert(schema.customerContact).values({
                    customerId: owner.id,
                    userId,
                    role: "owner",
                    email: "grenze@example.test",
                });

                // A limit of 10 000,00 € makes the boundaries countable.
                const limited: Settings = {
                    ...SETTINGS,
                    revenue: {
                        ...SETTINGS.revenue,
                        kleinunternehmerCurrentLimitCents: 1_000_000,
                    },
                };

                const at = new Date("2026-06-15T10:00:00Z");

                // The admin action and the API route both call this after
                // every finalization and every payment, which is the only
                // reason the 80 % warning is ever reached: revenue that
                // jumps straight past it would only trigger the 100 % one.
                const { notifyThresholds } = await import(
                    "@/server/billing/revenue-notify"
                );

                const bill = async (cents: number) => {
                    const row = await createInvoiceDraft(
                        fresh.db,
                        {
                            customerId: owner.id,
                            servicePeriodStart: at,
                            items: [
                                {
                                    description: "Leistung",
                                    quantity: 1,
                                    unitCode: "C62",
                                    unitPriceCents: cents,
                                },
                            ],
                        },
                        ACTOR,
                    );

                    await finalizeInvoice(fresh.db, row.id, ACTOR, {
                        now: at,
                        settings: limited,
                    });
                    await markInvoicePaid(fresh.db, row.id, ACTOR, at);
                    await notifyThresholds(fresh.db, at, limited);
                };

                // One cent short of 80 %.
                await bill(799_999);

                let status = await thresholdStatus(fresh.db, limited, at);

                expect(status.current.netCents).toBe(799_999);
                expect(status.current.level).toBeNull();

                // That one cent.
                await bill(1);
                status = await thresholdStatus(fresh.db, limited, at);

                expect(status.current.netCents).toBe(800_000);
                expect(status.current.level).toBe(80);
                expect(status.stillSmallBusiness).toBe(true);

                // And up to the limit itself: the scheme ends at it, not past it.
                await bill(200_000);
                status = await thresholdStatus(fresh.db, limited, at);

                expect(status.current.netCents).toBe(1_000_000);
                expect(status.current.level).toBe(100);
                expect(status.stillSmallBusiness).toBe(false);

                // Each warning goes out once, however often the check runs.
                await notifyThresholds(fresh.db, at, limited);
                await notifyThresholds(fresh.db, at, limited);

                const notices = await fresh.db
                    .select()
                    .from(schema.revenueNotice);

                expect(
                    notices
                        .filter((row) => row.metric === "current")
                        .map((row) => row.level)
                        .sort((a, b) => a - b),
                ).toEqual([80, 100]);
            } finally {
                await fresh.drop();
            }
        }, 60_000);
    });

    describe("the document store", () => {
        let root: string;

        beforeAll(async () => {
            root = await mkdtemp(path.join(tmpdir(), "virtify-docs-"));
        });

        afterAll(async () => {
            await rm(root, { recursive: true, force: true });
        });

        it("writes the bytes once and reads them back", async () => {
            const { localStorage } = await import("@/server/storage/local");
            const store = localStorage(root);

            const written = await store.put(
                "invoices/2026/RE-2026-0001.pdf",
                Buffer.from("%PDF-1.7 hello"),
                "application/pdf",
            );

            expect(written.bytes).toBe(14);
            expect(written.sha256).toHaveLength(64);
            expect(await store.exists("invoices/2026/RE-2026-0001.pdf")).toBe(
                true,
            );
            expect(
                (await store.get("invoices/2026/RE-2026-0001.pdf"))?.toString(),
            ).toBe("%PDF-1.7 hello");
            expect(await store.get("invoices/2026/missing.pdf")).toBeNull();
        });

        it("refuses a key that would climb out of the root", async () => {
            const { localStorage } = await import("@/server/storage/local");
            const store = localStorage(root);

            await expect(store.get("../../etc/passwd")).rejects.toThrow(
                /Invalid storage key/,
            );
            await expect(store.get("/etc/passwd")).rejects.toThrow(
                /Invalid storage key/,
            );
        });
    });

    async function counter() {
        const [row] = await db
            .select()
            .from(schema.documentCounter)
            .where(eq(schema.documentCounter.scope, "invoice:2026"));

        return row?.value ?? 0;
    }
});
