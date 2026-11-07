import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createId } from "@/lib/ulid";
import {
    createInvoiceDraft,
    finalizeInvoice,
} from "@/server/billing/invoices/service";
import { creditBalanceCents } from "@/server/payments/apply";
import { defaultSettings, type Settings } from "@/server/settings";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * The PayPal subscription mode: PayPal runs the schedule, and the money it
 * collects has to land on our books.
 *
 * The thing being proved is the *mapping*, which is why it needs a real
 * database and a mocked network rather than the other way round. PayPal's
 * `PAYMENT.SALE.COMPLETED` names a billing agreement and an amount and
 * nothing else — no invoice, because PayPal has never heard of ours. What
 * decides where the money goes is our own books: the subscription names the
 * account, the account's oldest open invoice takes the money, and the
 * ordinary settlement arithmetic does the rest. Nothing guesses.
 */

const available = await databaseAvailable();

if (!available) {
    console.warn(
        "\n[tests] No database reachable — the PayPal subscription mapping\n" +
            "        proofs are being SKIPPED. Run `npm run db:up`.\n",
    );
}

const ACTOR = { type: "system" as const, label: "test" };

const SETTINGS: Settings = {
    ...defaultSettings,
    operator: {
        ...defaultSettings.operator,
        country: "DE",
        taxNumber: "305/5721/1234",
    },
};

vi.mock("@/server/payments/settings", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/server/payments/settings")
        >();

    return {
        ...actual,
        gatewayConfig: vi.fn(async () => ({
            id: "paypal",
            label: "PayPal",
            enabled: true,
            mode: "sandbox" as const,
            source: "environment" as const,
            paypalRecurringMode: "subscriptions" as const,
            credentials: {
                clientId: "client",
                clientSecret: "secret",
                webhookId: "WH-1",
            },
        })),
        appUrl: () => "https://example.test",
    };
});

describe.skipIf(!available)("a PayPal-run subscription", () => {
    let db: TestDb;
    let drop: () => Promise<void>;
    let nextNumber = 30_000;

    /**
     * An account of its own per test. The mapping deliberately picks the
     * *account's* oldest open invoice, so one shared account would make each
     * test depend on what the one before it left open.
     */
    async function account() {
        const userId = createId("user");
        const number = ++nextNumber;

        await db.insert(schema.user).values({
            id: userId,
            name: `Kunde ${number}`,
            email: `kunde${number}@example.test`,
            emailVerified: true,
        });

        const [row] = await db
            .insert(schema.customer)
            .values({
                name: `Kunde ${number}`,
                customerNumber: number,
                country: "DE",
                street: "Musterweg 1",
                postalCode: "12345",
                city: "Musterstadt",
            })
            .returning();

        await db.insert(schema.customerContact).values({
            customerId: row.id,
            userId,
            role: "owner",
            email: `kunde${number}@example.test`,
        });

        return row.id;
    }

    async function issued(customerId: string, cents: number, at: string) {
        const draft = await createInvoiceDraft(
            db,
            {
                customerId,
                items: [
                    {
                        description: "VPS M",
                        quantity: 1,
                        unitCode: "MON",
                        unitPriceCents: cents,
                    },
                ],
            },
            ACTOR,
        );

        const { invoice } = await finalizeInvoice(db, draft.id, ACTOR, {
            now: new Date(at),
            settings: SETTINGS,
            paymentTermDays: 14,
        });

        return invoice;
    }

    async function subscription(customerId: string, ref: string) {
        const [row] = await db
            .insert(schema.subscription)
            .values({
                id: createId("subscription"),
                customerId,
                cycle: "monthly",
                currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
                gateway: "paypal",
                gatewaySubscriptionRef: ref,
            })
            .returning();

        return row;
    }

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());
    });

    afterAll(async () => {
        await drop();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("settles the account's oldest open invoice", async () => {
        const { mapSubscriptionSale } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        const customerId = await account();
        const older = await issued(customerId, 1999, "2026-11-01T10:00:00Z");
        await issued(customerId, 1999, "2026-12-01T10:00:00Z");
        await subscription(customerId, "I-OLDEST");

        const mapping = await mapSubscriptionSale(db, {
            billingAgreementId: "I-OLDEST",
            saleId: "SALE-OLDEST",
            amountCents: 1999,
            feeCents: 66,
            currency: "EUR",
        });

        expect(mapping).toMatchObject({ matched: true, invoiceId: older.id });

        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, older.id));

        expect(row.status).toBe("paid");
        expect(row.paidCents).toBe(1999);

        const [payment] = await db
            .select()
            .from(schema.payment)
            .where(eq(schema.payment.providerRef, "SALE-OLDEST"));

        expect(payment.provider).toBe("paypal");
        expect(payment.feeCents).toBe(66);
        expect(payment.note).toContain("I-OLDEST");
    });

    it("the same sale reported twice settles once", async () => {
        const { mapSubscriptionSale } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        const customerId = await account();
        const invoice = await issued(customerId, 1999, "2027-01-01T10:00:00Z");
        await subscription(customerId, "I-DUPE");

        const sale = {
            billingAgreementId: "I-DUPE",
            saleId: "SALE-DUPE",
            amountCents: 1999,
            feeCents: null,
            currency: "EUR",
        };

        await mapSubscriptionSale(db, sale);
        await mapSubscriptionSale(db, sale);

        const [row] = await db
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, invoice.id));

        expect(row.paidCents).toBe(1999);

        const payments = await db
            .select()
            .from(schema.payment)
            .where(eq(schema.payment.invoiceId, invoice.id));

        expect(payments).toHaveLength(1);
    });

    it("with nothing open, the money becomes credit rather than vanishing", async () => {
        const { mapSubscriptionSale } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        // Every invoice of this account is settled by now, and PayPal has
        // collected anyway — which it will, because it runs the schedule.
        // The one outcome that can never be wrong is that the money is the
        // customer's.
        const customerId = await account();
        await subscription(customerId, "I-NOTHING-OPEN");

        const before = await creditBalanceCents(db, customerId);

        const mapping = await mapSubscriptionSale(db, {
            billingAgreementId: "I-NOTHING-OPEN",
            saleId: "SALE-CREDIT",
            amountCents: 1999,
            feeCents: null,
            currency: "EUR",
        });

        expect(mapping.matched).toBe(true);

        expect(await creditBalanceCents(db, customerId)).toBe(before + 1999);
    });

    it("a sale for a subscription we do not know is not booked", async () => {
        const { mapSubscriptionSale } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        const mapping = await mapSubscriptionSale(db, {
            billingAgreementId: "I-UNKNOWN",
            saleId: "SALE-UNKNOWN",
            amountCents: 9999,
            feeCents: null,
            currency: "EUR",
        });

        expect(mapping.matched).toBe(false);

        const payments = await db
            .select()
            .from(schema.payment)
            .where(eq(schema.payment.providerRef, "SALE-UNKNOWN"));

        expect(payments).toHaveLength(0);
    });

    it("creates a plan once and reuses it", async () => {
        const { ensurePlan } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        const calls: string[] = [];

        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            const path = String(url);

            if (path.includes("/v1/oauth2/token")) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        access_token: "t",
                        expires_in: 3600,
                    }),
                } as unknown as Response;
            }

            calls.push(path);

            if (path.endsWith("/v1/catalogs/products")) {
                return {
                    ok: true,
                    status: 201,
                    json: async () => ({ id: "PROD-1" }),
                } as unknown as Response;
            }

            // The plan has to carry our price and no tax: § 19 UStG means
            // this seller shows no tax line, at PayPal either.
            const body = JSON.parse(String(init?.body));

            expect(
                body.billing_cycles[0].pricing_scheme.fixed_price.value,
            ).toBe("19.99");
            expect(body.taxes.percentage).toBe("0");

            return {
                ok: true,
                status: 201,
                json: async () => ({ id: "PLAN-1" }),
            } as unknown as Response;
        });

        vi.stubGlobal("fetch", fetchMock);

        const first = await ensurePlan(db, {
            cycle: "monthly",
            unitAmountCents: 1999,
            currency: "EUR",
            name: "VPS M",
        });

        expect(first).toEqual({
            paypalPlanId: "PLAN-1",
            paypalProductId: "PROD-1",
        });
        expect(calls).toHaveLength(2);

        // The second ask reads the row rather than making a second plan —
        // PayPal would happily create one, and two plans for one price is
        // how half the customers end up on a plan nobody updates.
        const second = await ensurePlan(db, {
            cycle: "monthly",
            unitAmountCents: 1999,
            currency: "EUR",
            name: "VPS M",
        });

        expect(second).toEqual(first);
        expect(calls).toHaveLength(2);
    });

    it("refuses a billing rhythm PayPal does not have", async () => {
        const { ensurePlan } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        await expect(
            ensurePlan(db, {
                cycle: "weekly",
                unitAmountCents: 1999,
                currency: "EUR",
                name: "VPS M",
            }),
        ).rejects.toThrow(/Abrechnungsrhythmus/);
    });
});
