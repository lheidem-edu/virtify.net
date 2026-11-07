import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createCustomerForUser,
    customerForUser,
    getCustomer,
    listCustomers,
    updateCustomer,
} from "@/server/customers/repository";
import {
    listContracts,
    listInvoices,
    listOffers,
    loadContract,
    loadInvoice,
    loadOffer,
} from "@/server/documents/repository";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * The claim this file exists to prove: a customer cannot reach another
 * customer's rows, however the query is reached.
 *
 * It runs against a real Postgres, because that is where the claim lives — a
 * stubbed `select()` returns whatever the stub was told to, which is exactly
 * the bug this is meant to catch.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the scoping, permission and API-key\n" +
            "        proofs are being SKIPPED. Run `npm run db:up` and try again.\n",
    );
}

type Side = {
    customerId: string;
    userId: string;
    invoiceId: string;
    contractId: string;
    offerId: string;
};

describe.skipIf(!available)("client-area scoping", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    const mine = { userId: "user_01MTESTAAAAAAAAAAAAAAAAAA" } as Side;
    const theirs = { userId: "user_01MTESTBBBBBBBBBBBBBBBBBB" } as Side;

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        for (const [index, side] of [mine, theirs].entries()) {
            await db.insert(schema.user).values({
                id: side.userId,
                name: `Kunde ${index}`,
                email: `kunde${index}@example.test`,
                emailVerified: true,
            });

            const customer = await createCustomerForUser(db, {
                id: side.userId,
                name: `Kunde ${index}`,
                email: `kunde${index}@example.test`,
            });

            side.customerId = customer.id;

            const [contract] = await db
                .insert(schema.contract)
                .values({
                    customerId: customer.id,
                    number: `V-${index}`,
                    title: `Vertrag ${index}`,
                    monthlyPriceCents: 1000,
                })
                .returning();

            side.contractId = contract.id;

            const [invoice] = await db
                .insert(schema.invoice)
                .values({
                    customerId: customer.id,
                    contractId: contract.id,
                    number: `RE-2026-000${index}`,
                    status: "issued",
                })
                .returning();

            side.invoiceId = invoice.id;

            await db.insert(schema.invoiceItem).values({
                invoiceId: invoice.id,
                position: 1,
                description: `Leistung ${index}`,
                quantity: 1,
                unitPriceCents: 1000,
            });

            const [offer] = await db
                .insert(schema.offer)
                .values({
                    customerId: customer.id,
                    number: `AN-2026-000${index}`,
                    title: `Angebot ${index}`,
                    monthlyPriceCents: 1000,
                })
                .returning();

            side.offerId = offer.id;
        }
    });

    afterAll(async () => {
        await drop?.();
    });

    it("resolves a login to its own account and to no other", async () => {
        const row = await customerForUser(db, mine.userId);

        expect(row?.customer.id).toBe(mine.customerId);
        expect(row?.contact.role).toBe("owner");
        expect(row?.customer.id).not.toBe(theirs.customerId);
    });

    it("gives a sign-up its own customer number from the gapless counter", async () => {
        const first = await getCustomer(db, mine.customerId);
        const second = await getCustomer(db, theirs.customerId);

        expect(first?.customerNumber).toBeGreaterThan(10000);
        expect(second?.customerNumber).toBe((first?.customerNumber ?? 0) + 1);
    });

    it("lists only the account's own invoices, contracts and offers", async () => {
        const invoices = await listInvoices(mine.customerId, false, db);
        const contracts = await listContracts(mine.customerId, false, db);
        const offers = await listOffers(mine.customerId, false, db);

        expect(invoices.map((row) => row.id)).toEqual([mine.invoiceId]);
        expect(contracts.map((row) => row.id)).toEqual([mine.contractId]);
        expect(offers.map((row) => row.id)).toEqual([mine.offerId]);

        expect(invoices.map((row) => row.id)).not.toContain(theirs.invoiceId);
        expect(contracts.map((row) => row.id)).not.toContain(theirs.contractId);
        expect(offers.map((row) => row.id)).not.toContain(theirs.offerId);
    });

    it("refuses to load another customer's documents by id", async () => {
        expect(
            await loadInvoice(theirs.invoiceId, mine.customerId, false, db),
        ).toBeNull();
        expect(
            await loadOffer(theirs.offerId, mine.customerId, false, db),
        ).toBeNull();
        expect(
            await loadContract(theirs.contractId, mine.customerId, false, db),
        ).toBeNull();
    });

    it("still loads the customer's own documents, so the guard is not blanket", async () => {
        const invoice = await loadInvoice(
            mine.invoiceId,
            mine.customerId,
            false,
            db,
        );

        expect(invoice?.invoice.id).toBe(mine.invoiceId);
        expect(invoice?.buyer.email).toBe("kunde0@example.test");
        expect(invoice?.totals.netCents).toBe(1000);
    });

    it("lets an employee see both accounts, which is what the flag is for", async () => {
        const all = await listInvoices("", true, db);

        expect(all.map((row) => row.id).sort()).toEqual(
            [mine.invoiceId, theirs.invoiceId].sort(),
        );
    });

    it("pages the customer list by id without repeating or skipping a row", async () => {
        const first = await listCustomers(db, { limit: 1 });

        expect(first.data).toHaveLength(1);
        expect(first.has_more).toBe(true);

        const second = await listCustomers(db, {
            limit: 1,
            cursor: first.next_cursor,
        });

        expect(second.data).toHaveLength(1);
        expect(second.data[0].id).not.toBe(first.data[0].id);
        expect(second.has_more).toBe(false);
    });

    it("finds an account by its contact's address", async () => {
        const found = await listCustomers(db, { query: "kunde1@example.test" });

        expect(found.data.map((row) => row.id)).toEqual([theirs.customerId]);
    });

    it("hides a soft-deleted account from every read", async () => {
        const [spare] = await db
            .insert(schema.customer)
            .values({
                customerNumber: 99999,
                name: "Gelöscht",
                deletedAt: new Date(),
            })
            .returning();

        expect(await getCustomer(db, spare.id)).toBeNull();
        expect(
            (await listCustomers(db, {})).data.map((row) => row.id),
        ).not.toContain(spare.id);
    });

    it("writes an audit entry for every change, with before and after", async () => {
        await updateCustomer(
            db,
            theirs.customerId,
            { company: "Beispiel GmbH" },
            { type: "staff", id: "staffuser_x", label: "chef@example.test" },
        );

        const log = await db
            .select()
            .from(schema.auditLog)
            .where(eq(schema.auditLog.entityId, theirs.customerId));

        const update = log.find((row) => row.action === "customer.update");

        expect(update).toBeDefined();
        expect(update?.actorType).toBe("staff");
        expect(update?.actorLabel).toBe("chef@example.test");
        expect(update?.before).toEqual({ company: null });
        expect(update?.after).toEqual({ company: "Beispiel GmbH" });
    });

    it("records nothing when a save changes nothing", async () => {
        await updateCustomer(
            db,
            mine.customerId,
            { city: "Münster" },
            { type: "staff", id: "staffuser_x" },
        );

        const before = await db
            .select()
            .from(schema.auditLog)
            .where(
                and(
                    eq(schema.auditLog.entityId, mine.customerId),
                    eq(schema.auditLog.action, "customer.update"),
                ),
            );

        await updateCustomer(
            db,
            mine.customerId,
            { city: "Münster" },
            { type: "staff", id: "staffuser_x" },
        );

        const after = await db
            .select()
            .from(schema.auditLog)
            .where(
                and(
                    eq(schema.auditLog.entityId, mine.customerId),
                    eq(schema.auditLog.action, "customer.update"),
                ),
            );

        expect(after).toHaveLength(before.length);
    });
});
