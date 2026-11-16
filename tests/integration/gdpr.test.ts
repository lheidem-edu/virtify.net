import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "@/lib/zip";
import {
    AnonymizationRefused,
    anonymizationBlockers,
    anonymizeCustomer,
    exportCustomerData,
    FIELDS_KEPT,
} from "@/server/customers/gdpr";
import { transitionSubscription } from "@/server/subscriptions/service";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";
import {
    ACTOR,
    anchored,
    makeCustomer,
    makeGroup,
    makeProduct,
    order,
} from "../helpers/fixtures";

/**
 * Auskunft and Anonymisierung, against a real Postgres — because both are
 * claims about which rows come back and which rows survive, and the invoice
 * immutability triggers that make the second one interesting only exist in
 * the database.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the DSGVO proofs are being\n" +
            "        SKIPPED. Run `npm run db:up`.\n",
    );
}

const SETTINGS = anchored(1);
const NOW = new Date("2026-11-20T09:00:00.000Z");

describe.skipIf(!available)("DSGVO", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let groupId: string;
    let vpsM: string;
    let seq = 80_000;

    async function nextCustomer() {
        seq += 1;
        return makeCustomer(db, seq);
    }

    beforeAll(async () => {
        const created = await createTestDatabase();

        db = created.db;
        drop = created.drop;
        groupId = await makeGroup(db);
        vpsM = await makeProduct(db, {
            groupId,
            slug: "vps-m",
            name: "VPS M",
            cycle: "monthly",
            priceCents: 1999,
        });
    });

    afterAll(async () => {
        await drop();
    });

    /* -------------------------------------------------------------- */
    /* Auskunft                                                        */
    /* -------------------------------------------------------------- */

    describe("the export", () => {
        it("hands back one account's rows, as a readable archive", async () => {
            const customerId = await nextCustomer();
            const other = await nextCustomer();

            await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: NOW,
                settings: SETTINGS,
            });

            await order(db, {
                customerId: other,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: NOW,
                settings: SETTINGS,
            });

            const result = await exportCustomerData(db, customerId, {
                now: NOW,
            });

            const entries = readZip(result.bytes);
            const manifest = entries.find(
                (entry) => entry.name === "daten.json",
            );

            expect(manifest).toBeDefined();
            expect(entries.every((entry) => entry.crcOk)).toBe(true);

            const document = JSON.parse(
                manifest?.content.toString("utf8") ?? "",
            );

            expect(document.meta.format).toBe("virtify.net/gdpr-export");
            expect(document.customer.id).toBe(customerId);
            expect(document.invoices).toHaveLength(1);
            expect(document.subscriptions).toHaveLength(1);
            expect(document.services).toHaveLength(1);
            expect(document.orders).toHaveLength(1);

            /**
             * **The scoping claim.** The other account placed the same order
             * a moment ago; not one of its rows may be in here. This is the
             * assertion the whole export exists behind — a bulk read of
             * everything one person has is exactly the shape of a leak.
             */
            const serialised = JSON.stringify(document);

            expect(serialised).not.toContain(other);
            expect(serialised).not.toContain(`kunde${seq}@example.test`);
        });

        it("leaves out what Art. 15 Abs. 4 protects and what is not an auskunft", async () => {
            const customerId = await nextCustomer();

            await db
                .update(schema.customer)
                .set({
                    notes: "Zahlt immer zu spät — intern.",
                    stripeCustomerId: `cus_${seq}`,
                })
                .where(eq(schema.customer.id, customerId));

            const result = await exportCustomerData(db, customerId, {
                now: NOW,
            });
            const manifest = readZip(result.bytes).find(
                (entry) => entry.name === "daten.json",
            );
            const text = manifest?.content.toString("utf8") ?? "";

            // Staff commentary about a customer is the customer's personal
            // data *and* somebody else's assessment.
            expect(text).not.toContain("intern");
            expect(text).not.toContain(`cus_${seq}`);
            expect(JSON.parse(text).customer.notes).toBeUndefined();
        });

        it("names a document it could not read rather than leaving a hole", async () => {
            const customerId = await nextCustomer();

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: NOW,
                settings: SETTINGS,
            });

            // A key with nothing behind it: the state a storage swap or a lost
            // volume leaves.
            await db
                .update(schema.invoice)
                .set({ pdfKey: "invoices/gone.pdf" })
                .where(eq(schema.invoice.id, placed.invoiceId as string));

            const result = await exportCustomerData(db, customerId, {
                now: NOW,
            });

            expect(result.summary.missingDocuments).toHaveLength(1);

            const names = readZip(result.bytes).map((entry) => entry.name);

            expect(names).toContain("FEHLENDE-DOKUMENTE.txt");
        });
    });

    /* -------------------------------------------------------------- */
    /* Anonymisierung                                                  */
    /* -------------------------------------------------------------- */

    describe("anonymisation", () => {
        it("refuses an account that still owes money", async () => {
            const customerId = await nextCustomer();

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: NOW,
                settings: SETTINGS,
            });

            /**
             * The Abo is ended first, so the **invoice** is the only thing in
             * the way. Without that this case passes whichever of the two
             * refusals fires, and a mutation that removed the invoice check
             * would survive — which is exactly what it did before this line
             * was here.
             */
            for (const id of placed.subscriptionIds) {
                await transitionSubscription(db, {
                    subscriptionId: id,
                    to: "ended",
                    summary: "Beendet für den Test.",
                    actor: ACTOR,
                    at: NOW,
                });
            }

            const blockers = await anonymizationBlockers(db, customerId);

            expect(blockers.join(" ")).toContain("offene Rechnung");
            expect(blockers.join(" ")).not.toContain("Abo");

            await expect(
                anonymizeCustomer(db, customerId, ACTOR, { now: NOW }),
            ).rejects.toThrow(AnonymizationRefused);
            // The *reason*, not just the class: the two refusals are
            // different states with different remedies.
            await expect(
                anonymizeCustomer(db, customerId, ACTOR, { now: NOW }),
            ).rejects.toThrow(/offen/);

            // Nothing moved: half an anonymisation is the worst of both.
            const [row] = await db
                .select()
                .from(schema.customer)
                .where(eq(schema.customer.id, customerId));

            expect(row.name).toContain("Kunde");
            expect(row.status).toBe("active");
        });

        it("refuses an account whose Abo is still running", async () => {
            const customerId = await nextCustomer();

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: NOW,
                settings: SETTINGS,
            });

            // Settle the invoice so only the Abo is in the way.
            await db
                .update(schema.invoice)
                .set({ status: "paid", paidAt: NOW })
                .where(eq(schema.invoice.id, placed.invoiceId as string));

            const blockers = await anonymizationBlockers(db, customerId);

            expect(blockers.join(" ")).toContain("Abo");

            await expect(
                anonymizeCustomer(db, customerId, ACTOR, { now: NOW }),
            ).rejects.toThrow(/Abo/);
        });

        it("rewrites the person and keeps the documents", async () => {
            const customerId = await nextCustomer();
            const number = seq;

            const placed = await order(db, {
                customerId,
                items: [{ productId: vpsM, cycle: "monthly" }],
                now: NOW,
                settings: SETTINGS,
            });

            const invoiceId = placed.invoiceId as string;

            const [before] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId));

            await db
                .update(schema.invoice)
                .set({ status: "paid", paidAt: NOW })
                .where(eq(schema.invoice.id, invoiceId));

            for (const id of placed.subscriptionIds) {
                await transitionSubscription(db, {
                    subscriptionId: id,
                    to: "ended",
                    summary: "Beendet für den Test.",
                    actor: ACTOR,
                    at: NOW,
                });
            }

            const result = await anonymizeCustomer(db, customerId, ACTOR, {
                now: NOW,
                reason: "Auf Wunsch des Kunden",
            });

            expect(result.contacts).toBe(1);
            expect(result.logins).toBe(1);

            const [customer] = await db
                .select()
                .from(schema.customer)
                .where(eq(schema.customer.id, customerId));

            expect(customer.name).toBe(`Anonymisiert (${number})`);
            expect(customer.street).toBeNull();
            expect(customer.city).toBeNull();
            expect(customer.phone).toBeNull();
            expect(customer.vatId).toBeNull();
            expect(customer.status).toBe("closed");
            expect(customer.deletedAt).not.toBeNull();
            // The provider-side identity goes too: it is a copy of this
            // person's name and address at Stripe, and the id is a pointer.
            expect(customer.stripeCustomerId).toBeNull();

            const contacts = await db
                .select()
                .from(schema.customerContact)
                .where(eq(schema.customerContact.customerId, customerId));

            expect(contacts[0].email).toBe(`${number}.anonymisiert.invalid`);

            /**
             * **What is kept, and why.** The buyer snapshot on the finalized
             * invoice is unchanged: § 14 Abs. 4 UStG wants it on the
             * document, § 147 AO wants the document for ten years, and
             * Art. 17 Abs. 3 lit. b DSGVO exempts exactly that. The
             * immutability trigger from migration 0017 would refuse the write
             * anyway, which is the point — the rule is enforced below the
             * application, not by it.
             */
            const [after] = await db
                .select()
                .from(schema.invoice)
                .where(eq(schema.invoice.id, invoiceId));

            expect(after.buyerName).toBe(before.buyerName);
            expect(after.buyerCity).toBe(before.buyerCity);
            expect(after.recipient).toBe(before.recipient);
            expect(after.number).toBe(before.number);
            expect(Object.keys(FIELDS_KEPT)).toContain("invoice");

            // And the audit entry that says it happened.
            const log = await db
                .select()
                .from(schema.auditLog)
                .where(eq(schema.auditLog.entityId, customerId));

            const entry = log.find(
                (row) => row.action === "customer.anonymize",
            );

            expect(entry).toBeDefined();
            expect((entry?.after as { reason?: string })?.reason).toBe(
                "Auf Wunsch des Kunden",
            );
        });

        it("takes the logins away rather than leaving a way back in", async () => {
            const customerId = await nextCustomer();
            const number = seq;

            const [contact] = await db
                .select()
                .from(schema.customerContact)
                .where(eq(schema.customerContact.customerId, customerId));

            await db.insert(schema.session).values({
                id: `session_${number}`,
                userId: contact.userId,
                token: `token_${number}`,
                expiresAt: new Date(NOW.getTime() + 86_400_000),
            });

            await anonymizeCustomer(db, customerId, ACTOR, { now: NOW });

            const sessions = await db
                .select()
                .from(schema.session)
                .where(eq(schema.session.userId, contact.userId));

            // A session that outlives the credential *is* the credential.
            expect(sessions).toHaveLength(0);

            const [user] = await db
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, contact.userId));

            // The row stays — `customer_contact` points at it and the audit
            // log names it as an actor (rule 10) — but it is nobody.
            expect(user).toBeDefined();
            expect(user.email).toBe(`${number}.anonymisiert.invalid`);
            expect(user.emailVerified).toBe(false);
        });

        it("cancels anything still queued for that address", async () => {
            const customerId = await nextCustomer();

            await db.insert(schema.emailLog).values({
                template: "welcome",
                dedupeKey: `customer:${customerId}`,
                toEmail: `kunde${seq}@example.test`,
                customerId,
                payload: {},
            });

            await anonymizeCustomer(db, customerId, ACTOR, { now: NOW });

            const [mail] = await db
                .select()
                .from(schema.emailLog)
                .where(eq(schema.emailLog.customerId, customerId));

            // A notification that went out afterwards would be addressed to
            // `anonymisiert.invalid` — a bounce at best.
            expect(mail.status).toBe("abandoned");
            expect(mail.lastError).toContain("anonymisiert");
        });

        it("refuses to do it twice", async () => {
            const customerId = await nextCustomer();

            await anonymizeCustomer(db, customerId, ACTOR, { now: NOW });

            await expect(
                anonymizeCustomer(db, customerId, ACTOR, { now: NOW }),
            ).rejects.toThrow(/bereits anonymisiert/);
        });
    });
});
