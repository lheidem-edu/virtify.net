import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * The catalog against a real Postgres: the unique indexes, the soft delete,
 * the audit rows and the price function reading what the admin area wrote.
 *
 * The arithmetic itself is covered in tests/unit/pricing.test.ts; what is
 * claimed here is that the rows round-trip and that the quote comes out of
 * them with the same numbers.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("the catalog", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    const system = { type: "system" as const };

    let repository: typeof import("@/server/catalog/repository");
    let quote: typeof import("@/server/billing/quote");

    let groupId = "";
    let productId = "";

    /** The product is created in beforeAll; a null here is a broken fixture. */
    async function loadProduct() {
        const row = await repository.getProduct(db, productId);

        if (!row) {
            throw new Error("Das Produkt der Fixture fehlt.");
        }

        return row;
    }

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        repository = await import("@/server/catalog/repository");
        quote = await import("@/server/billing/quote");

        groupId = (
            await repository.createGroup(
                db,
                {
                    slug: "vps",
                    name: "KVM-Instanzen",
                    tagline: "Virtuelle Maschinen auf eigener Hardware",
                    description: null,
                    sortOrder: 0,
                    hidden: false,
                },
                system,
            )
        ).id;

        productId = (
            await repository.createProduct(
                db,
                {
                    groupId,
                    slug: "vps-m",
                    name: "VPS M",
                    type: "vps",
                    status: "active",
                    tagline: "4 vCPU, 8 GB RAM",
                    description: null,
                    sortOrder: 0,
                    module: "none",
                    moduleConfig: {},
                    maxQuantity: 5,
                },
                system,
            )
        ).id;

        await repository.setProductPricing(
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
                {
                    cycle: "annual",
                    currency: "EUR",
                    priceCents: 19_990,
                    setupFeeCents: 0,
                    trialDays: 14,
                },
            ],
            system,
        );
    }, 60_000);

    afterAll(async () => {
        await drop?.();
    });

    it("refuses a second product with the same slug", async () => {
        await expect(
            repository.createProduct(
                db,
                {
                    groupId,
                    slug: "vps-m",
                    name: "Noch ein VPS M",
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
            ),
        ).rejects.toThrow(/schon vergeben/);
    });

    it("refuses a module configuration the module cannot read", async () => {
        await expect(
            repository.updateProduct(
                db,
                productId,
                { moduleConfig: { node: "pve-01" } },
                system,
            ),
        ).rejects.toThrow(/Moduleinstellungen/);
    });

    it("writes an audit row inside the transaction that changed something", async () => {
        const trail = await db
            .select()
            .from(schema.auditLog)
            .where(
                and(
                    eq(schema.auditLog.entityType, "product"),
                    eq(schema.auditLog.entityId, productId),
                ),
            );

        expect(trail.map((row) => row.action)).toContain("product.create");
        expect(trail.map((row) => row.action)).toContain("product.pricing");
    });

    it("replaces the pricing matrix rather than adding to it", async () => {
        const before = await repository.listPricing(db, [productId]);

        expect(before).toHaveLength(2);

        await repository.setProductPricing(
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

        expect(await repository.listPricing(db, [productId])).toHaveLength(1);

        // Put the annual cell back for the rest of the file.
        await repository.setProductPricing(
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
                {
                    cycle: "annual",
                    currency: "EUR",
                    priceCents: 19_990,
                    setupFeeCents: 0,
                    trialDays: 14,
                },
            ],
            system,
        );
    });

    it("keeps an option value's id when it is saved again", async () => {
        const option = await repository.createConfigOption(
            db,
            productId,
            {
                name: "Arbeitsspeicher",
                description: null,
                type: "select",
                required: true,
                sortOrder: 0,
                minQuantity: 0,
                maxQuantity: 10,
            },
            system,
        );

        if (!option) {
            throw new Error("no option");
        }

        const first = await repository.setConfigOptionValues(
            db,
            option.id,
            [
                {
                    name: "8 GB",
                    sortOrder: 0,
                    isDefault: true,
                    pricing: [],
                },
                {
                    name: "16 GB",
                    sortOrder: 1,
                    isDefault: false,
                    pricing: [
                        {
                            cycle: "monthly",
                            currency: "EUR",
                            priceCents: 500,
                            setupFeeCents: 0,
                        },
                    ],
                },
            ],
            system,
        );

        if (!first) {
            throw new Error("no values");
        }

        const again = await repository.setConfigOptionValues(
            db,
            option.id,
            first.map((row, index) => ({
                id: row.id,
                name: row.name,
                sortOrder: index,
                isDefault: row.isDefault,
                pricing:
                    row.name === "16 GB"
                        ? [
                              {
                                  cycle: "monthly" as const,
                                  currency: "EUR",
                                  priceCents: 500,
                                  setupFeeCents: 0,
                              },
                          ]
                        : [],
            })),
            system,
        );

        expect(again?.map((row) => row.id)).toEqual(first.map((row) => row.id));
    });

    it("refuses two default values for one option", async () => {
        const option = await repository.createConfigOption(
            db,
            productId,
            {
                name: "Standort",
                description: null,
                type: "select",
                required: false,
                sortOrder: 9,
                minQuantity: 0,
                maxQuantity: 10,
            },
            system,
        );

        await expect(
            repository.setConfigOptionValues(
                db,
                option?.id ?? "",
                [
                    {
                        name: "Velbert",
                        sortOrder: 0,
                        isDefault: true,
                        pricing: [],
                    },
                    {
                        name: "Falkenstein",
                        sortOrder: 1,
                        isDefault: true,
                        pricing: [],
                    },
                ],
                system,
            ),
        ).rejects.toThrow(/Voreinstellung/);

        await repository.deleteConfigOption(db, option?.id ?? "", system);
    });

    it("prices a product out of the rows the admin area wrote", async () => {
        const product = await loadProduct();
        const detail = await repository.loadProductDetail(db, product);
        const ram = detail?.options.find(
            (entry) => entry.option.name === "Arbeitsspeicher",
        );
        const sixteen = ram?.values.find(
            (entry) => entry.value.name === "16 GB",
        );

        const { quote: result } = await quote.quoteProduct(db, product, {
            cycle: "monthly",
            currency: "EUR",
            quantity: 2,
            options: [
                {
                    optionId: ram?.option.id ?? "",
                    valueId: sixteen?.value.id ?? "",
                    quantity: 1,
                },
            ],
            couponCode: null,
        });

        // 2 × 19,99 € + 2 × 5,00 € laufend, 2 × 10,00 € Einrichtung.
        expect(result.totals.recurringGrossCents).toBe(4998);
        expect(result.totals.setupCents).toBe(2000);
        expect(result.totals.dueTodayCents).toBe(6998);
    });

    it("carries the trial of the chosen cycle, not of the product", async () => {
        const product = await loadProduct();
        const ram = (
            await repository.loadProductDetail(db, product)
        )?.options.find((entry) => entry.option.name === "Arbeitsspeicher");
        const eight = ram?.values.find((entry) => entry.value.name === "8 GB");

        const { quote: result } = await quote.quoteProduct(db, product, {
            cycle: "annual",
            currency: "EUR",
            quantity: 1,
            options: [
                {
                    optionId: ram?.option.id ?? "",
                    valueId: eight?.value.id ?? "",
                    quantity: 1,
                },
            ],
            couponCode: null,
        });

        expect(result.totals.trialDays).toBe(14);
        // Jahrespreis ohne Einrichtung, und die erste Zahlung liegt im Trial.
        expect(result.totals.dueTodayCents).toBe(0);
        expect(result.totals.firstPeriodCents).toBe(19_990);
    });

    it("refuses an option that belongs to another product", async () => {
        const product = await loadProduct();
        const ram = (
            await repository.loadProductDetail(db, product)
        )?.options.find((entry) => entry.option.name === "Arbeitsspeicher");
        const eight = ram?.values.find((entry) => entry.value.name === "8 GB");

        await expect(
            quote.quoteProduct(db, product, {
                cycle: "monthly",
                currency: "EUR",
                quantity: 1,
                options: [
                    {
                        optionId: ram?.option.id ?? "",
                        valueId: eight?.value.id ?? "",
                        quantity: 1,
                    },
                    {
                        optionId: "configoption_01NOTOURS",
                        valueId: "configoptionvalue_01NOTOURS",
                        quantity: 1,
                    },
                ],
                couponCode: null,
            }),
        ).rejects.toThrow(/keine Option dieses Produkts/);
    });

    it("refuses a value that belongs to another option", async () => {
        const product = await loadProduct();
        const ram = (
            await repository.loadProductDetail(db, product)
        )?.options.find((entry) => entry.option.name === "Arbeitsspeicher");

        await expect(
            quote.quoteProduct(db, product, {
                cycle: "monthly",
                currency: "EUR",
                quantity: 1,
                options: [
                    {
                        optionId: ram?.option.id ?? "",
                        valueId: "configoptionvalue_01SOMEWHEREELSE",
                        quantity: 1,
                    },
                ],
                couponCode: null,
            }),
        ).rejects.toThrow(/Arbeitsspeicher/);
    });

    it("insists on a required option", async () => {
        const product = await loadProduct();

        await expect(
            quote.quoteProduct(db, product, {
                cycle: "monthly",
                currency: "EUR",
                quantity: 1,
                options: [],
                couponCode: null,
            }),
        ).rejects.toThrow(/Arbeitsspeicher/);
    });

    it("refuses a cycle the product is not sold in", async () => {
        const product = await loadProduct();

        await expect(
            quote.quoteProduct(db, product, {
                cycle: "biennial",
                currency: "EUR",
                quantity: 1,
                options: [],
                couponCode: null,
            }),
        ).rejects.toThrow(/nicht angeboten/);
    });

    it("finds a coupon by code whatever case it was typed in", async () => {
        await repository.createCoupon(
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

        const product = await loadProduct();
        const ram = (
            await repository.loadProductDetail(db, product)
        )?.options.find((entry) => entry.option.name === "Arbeitsspeicher");
        const eight = ram?.values.find((entry) => entry.value.name === "8 GB");

        const { quote: result } = await quote.quoteProduct(db, product, {
            cycle: "monthly",
            currency: "EUR",
            quantity: 1,
            options: [
                {
                    optionId: ram?.option.id ?? "",
                    valueId: eight?.value.id ?? "",
                    quantity: 1,
                },
            ],
            couponCode: "  willkommen ",
        });

        expect(result.coupon?.code).toBe("WILLKOMMEN");
        // 25 % von 19,99 € sind 4,9975 € — aufgerundet 5,00 €.
        expect(result.totals.recurringDiscountCents).toBe(500);
        expect(result.totals.dueTodayCents).toBe(1499 + 1000);
    });

    it("says so when the code does not exist, without changing the price", async () => {
        const product = await loadProduct();
        const ram = (
            await repository.loadProductDetail(db, product)
        )?.options.find((entry) => entry.option.name === "Arbeitsspeicher");
        const eight = ram?.values.find((entry) => entry.value.name === "8 GB");

        const { quote: result } = await quote.quoteProduct(db, product, {
            cycle: "monthly",
            currency: "EUR",
            quantity: 1,
            options: [
                {
                    optionId: ram?.option.id ?? "",
                    valueId: eight?.value.id ?? "",
                    quantity: 1,
                },
            ],
            couponCode: "GIBTSNICHT",
        });

        expect(result.coupon).toBeNull();
        expect(result.couponError).toBe("Diesen Gutscheincode gibt es nicht.");
        expect(result.totals.firstPeriodCents).toBe(1999);
    });

    it("refuses to delete a group that still holds a product", async () => {
        await expect(
            repository.deleteGroup(db, groupId, system),
        ).rejects.toThrow(/noch Produkte/);
    });

    it("hides a soft-deleted product without removing the row", async () => {
        const doomed = await repository.createProduct(
            db,
            {
                groupId,
                slug: "vps-alt",
                name: "VPS Alt",
                type: "vps",
                status: "active",
                tagline: null,
                description: null,
                sortOrder: 0,
                module: "none",
                moduleConfig: {},
                maxQuantity: 1,
            },
            system,
        );

        await repository.softDeleteProduct(db, doomed.id, system);

        expect(await repository.getProduct(db, doomed.id)).toBeNull();

        const listed = await repository.listProducts(db, { limit: 100 });

        expect(listed.data.map((row) => row.id)).not.toContain(doomed.id);

        // The row is still there, which is the whole point of rule 10.
        const [raw] = await db
            .select()
            .from(schema.product)
            .where(eq(schema.product.id, doomed.id));

        expect(raw.deletedAt).not.toBeNull();
        expect(raw.status).toBe("retired");

        await repository.restoreProduct(db, doomed.id, system);

        expect(await repository.getProduct(db, doomed.id)).not.toBeNull();
    });

    it("renumbers groups when one is moved", async () => {
        const second = await repository.createGroup(
            db,
            {
                slug: "webhosting",
                name: "Webhosting",
                tagline: null,
                description: null,
                sortOrder: 0,
                hidden: false,
            },
            system,
        );

        await repository.moveGroup(db, second.id, "up", system);

        const ordered = await repository.listGroups(db);

        expect(ordered.map((row) => row.slug)).toEqual(["webhosting", "vps"]);

        await repository.moveGroup(db, second.id, "down", system);

        expect(
            (await repository.listGroups(db)).map((row) => row.slug),
        ).toEqual(["vps", "webhosting"]);

        await repository.deleteGroup(db, second.id, system);
    });
});
