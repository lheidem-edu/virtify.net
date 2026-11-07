import { and, asc, eq, gt, ilike, inArray, isNull, ne, or } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type {
    BillingCycle,
    ConfigOption,
    ConfigOptionPricing,
    ConfigOptionValue,
    Coupon,
    Product,
    ProductGroup,
    ProductPricing,
} from "@/db/schema/catalog";
import { type Actor, audit, diff } from "@/server/audit";
import type {
    ConfigOptionInput,
    ConfigOptionValueInput,
    CouponInput,
    ProductGroupInput,
    ProductInput,
    ProductPricingInput,
} from "@/server/catalog/schema";
import { parseModuleConfig } from "@/server/provisioning";

/**
 * Everything that reads or writes the catalog. Plain functions over a `db` or
 * a transaction, so a server action, an API route and a test all call the
 * same code and cannot drift apart.
 *
 * Every write runs in a transaction and leaves an audit entry inside it
 * (hard rules 4 and 8). Products are soft-deleted (rule 10): a subscription
 * or an invoice line will point at one long after it stops being sold.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export const DEFAULT_PAGE_SIZE = 25;

export class CatalogError extends Error {}

/** A product with everything a price or a product page needs. */
export type ProductDetail = {
    product: Product;
    group: ProductGroup;
    pricing: ProductPricing[];
    options: {
        option: ConfigOption;
        values: {
            value: ConfigOptionValue;
            pricing: ConfigOptionPricing[];
        }[];
    }[];
};

// --------------------------------------------------------------------------
// Groups
// --------------------------------------------------------------------------

export async function listGroups(
    db: Executor,
    options: { includeHidden?: boolean } = {},
) {
    return db
        .select()
        .from(schema.productGroup)
        .where(
            options.includeHidden
                ? undefined
                : eq(schema.productGroup.hidden, false),
        )
        .orderBy(
            asc(schema.productGroup.sortOrder),
            asc(schema.productGroup.id),
        );
}

export async function getGroup(db: Executor, id: string) {
    const [row] = await db
        .select()
        .from(schema.productGroup)
        .where(eq(schema.productGroup.id, id))
        .limit(1);

    return row ?? null;
}

export async function getGroupBySlug(db: Executor, slug: string) {
    const [row] = await db
        .select()
        .from(schema.productGroup)
        .where(eq(schema.productGroup.slug, slug))
        .limit(1);

    return row ?? null;
}

async function assertGroupSlugFree(
    db: Executor,
    slug: string,
    except?: string,
) {
    const [clash] = await db
        .select({ id: schema.productGroup.id })
        .from(schema.productGroup)
        .where(
            except
                ? and(
                      eq(schema.productGroup.slug, slug),
                      ne(schema.productGroup.id, except),
                  )
                : eq(schema.productGroup.slug, slug),
        )
        .limit(1);

    if (clash) {
        throw new CatalogError(`Das Kürzel „${slug}“ ist schon vergeben.`);
    }
}

export async function createGroup(
    db: Db,
    input: ProductGroupInput,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        await assertGroupSlugFree(tx, input.slug);

        const [row] = await tx
            .insert(schema.productGroup)
            .values(input)
            .returning();

        await audit(tx, {
            actor,
            action: "product_group.create",
            entityType: "product_group",
            entityId: row.id,
            after: { slug: row.slug, name: row.name, hidden: row.hidden },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

export async function updateGroup(
    db: Db,
    id: string,
    patch: Partial<ProductGroupInput>,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const before = await getGroup(tx, id);

        if (!before) {
            return null;
        }

        if (patch.slug && patch.slug !== before.slug) {
            await assertGroupSlugFree(tx, patch.slug, id);
        }

        const changes = diff(
            before as unknown as Record<string, unknown>,
            patch as Record<string, unknown>,
        );

        if (!changes) {
            return before;
        }

        const [row] = await tx
            .update(schema.productGroup)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(schema.productGroup.id, id))
            .returning();

        await audit(tx, {
            actor,
            action: "product_group.update",
            entityType: "product_group",
            entityId: id,
            before: changes.before,
            after: changes.after,
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

/**
 * Groups are removed outright rather than soft-deleted, and only while they
 * are empty. Nothing but a product ever points at one, so there is no
 * document to orphan — and a product that is still sold must not be able to
 * lose the heading it is sold under.
 */
export async function deleteGroup(
    db: Db,
    id: string,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const before = await getGroup(tx, id);

        if (!before) {
            return null;
        }

        const [child] = await tx
            .select({ id: schema.product.id })
            .from(schema.product)
            .where(eq(schema.product.groupId, id))
            .limit(1);

        if (child) {
            throw new CatalogError(
                "In dieser Gruppe liegen noch Produkte. Erst umhängen oder löschen.",
            );
        }

        await tx
            .delete(schema.productGroup)
            .where(eq(schema.productGroup.id, id));

        await audit(tx, {
            actor,
            action: "product_group.delete",
            entityType: "product_group",
            entityId: id,
            before: { slug: before.slug, name: before.name },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return before;
    });
}

/**
 * Moves a group one place up or down by swapping its sort order with its
 * neighbour's. Working on the neighbour rather than renumbering the whole
 * list keeps the write to two rows and leaves manually set orders alone.
 */
export async function moveGroup(
    db: Db,
    id: string,
    direction: "up" | "down",
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const ordered = await tx
            .select()
            .from(schema.productGroup)
            .orderBy(
                asc(schema.productGroup.sortOrder),
                asc(schema.productGroup.id),
            );

        const index = ordered.findIndex((row) => row.id === id);
        const target = index + (direction === "up" ? -1 : 1);

        if (index === -1 || target < 0 || target >= ordered.length) {
            return null;
        }

        // Renumber the whole list from zero first: two groups that share a
        // sort order would otherwise swap to no visible effect.
        const reordered = [...ordered];
        [reordered[index], reordered[target]] = [
            reordered[target],
            reordered[index],
        ];

        for (const [position, row] of reordered.entries()) {
            if (row.sortOrder !== position) {
                await tx
                    .update(schema.productGroup)
                    .set({ sortOrder: position, updatedAt: new Date() })
                    .where(eq(schema.productGroup.id, row.id));
            }
        }

        await audit(tx, {
            actor,
            action: "product_group.reorder",
            entityType: "product_group",
            entityId: id,
            before: { sortOrder: ordered[index].sortOrder },
            after: { sortOrder: target },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return reordered;
    });
}

// --------------------------------------------------------------------------
// Products
// --------------------------------------------------------------------------

export type ProductListOptions = {
    cursor?: string | null;
    limit?: number;
    groupId?: string | null;
    type?: Product["type"] | null;
    status?: Product["status"] | null;
    /** Matches name, slug and tagline. */
    query?: string | null;
    /** Only `active` and `hidden`; what the storefront and a customer see. */
    sellableOnly?: boolean;
};

export async function listProducts(
    db: Executor,
    options: ProductListOptions = {},
) {
    const limit = Math.min(
        Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1),
        100,
    );

    const filters: (ReturnType<typeof eq> | undefined)[] = [
        isNull(schema.product.deletedAt),
    ];

    if (options.cursor) {
        filters.push(gt(schema.product.id, options.cursor));
    }

    if (options.groupId) {
        filters.push(eq(schema.product.groupId, options.groupId));
    }

    if (options.type) {
        filters.push(eq(schema.product.type, options.type));
    }

    if (options.status) {
        filters.push(eq(schema.product.status, options.status));
    }

    if (options.sellableOnly) {
        filters.push(inArray(schema.product.status, ["active", "hidden"]));
    }

    const term = options.query?.trim();

    if (term) {
        const like = `%${term}%`;

        filters.push(
            or(
                ilike(schema.product.name, like),
                ilike(schema.product.slug, like),
                ilike(schema.product.tagline, like),
            ),
        );
    }

    // One row more than asked for: its presence answers `has_more` without a
    // second count over the whole table.
    const rows = await db
        .select()
        .from(schema.product)
        .where(and(...filters))
        .orderBy(asc(schema.product.id))
        .limit(limit + 1);

    const page = rows.slice(0, limit);

    return {
        data: page,
        has_more: rows.length > limit,
        next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
}

export async function getProduct(db: Executor, id: string) {
    const [row] = await db
        .select()
        .from(schema.product)
        .where(and(eq(schema.product.id, id), isNull(schema.product.deletedAt)))
        .limit(1);

    return row ?? null;
}

export async function getProductBySlug(db: Executor, slug: string) {
    const [row] = await db
        .select()
        .from(schema.product)
        .where(
            and(
                eq(schema.product.slug, slug),
                isNull(schema.product.deletedAt),
            ),
        )
        .limit(1);

    return row ?? null;
}

export async function listPricing(db: Executor, productIds: string[]) {
    if (productIds.length === 0) {
        return [];
    }

    return db
        .select()
        .from(schema.productPricing)
        .where(inArray(schema.productPricing.productId, productIds))
        .orderBy(
            asc(schema.productPricing.productId),
            asc(schema.productPricing.id),
        );
}

/**
 * The product with its group, its pricing matrix and every configuration
 * option it offers. Four queries rather than one join, because the join would
 * repeat the product on every option value and the assembly would be the
 * same work with more rows crossing the wire.
 */
export async function loadProductDetail(
    db: Executor,
    product: Product,
): Promise<ProductDetail | null> {
    const group = await getGroup(db, product.groupId);

    if (!group) {
        return null;
    }

    const pricing = await db
        .select()
        .from(schema.productPricing)
        .where(eq(schema.productPricing.productId, product.id))
        .orderBy(asc(schema.productPricing.id));

    const options = await db
        .select()
        .from(schema.configOption)
        .where(eq(schema.configOption.productId, product.id))
        .orderBy(
            asc(schema.configOption.sortOrder),
            asc(schema.configOption.id),
        );

    const optionIds = options.map((row) => row.id);

    const values = optionIds.length
        ? await db
              .select()
              .from(schema.configOptionValue)
              .where(inArray(schema.configOptionValue.optionId, optionIds))
              .orderBy(
                  asc(schema.configOptionValue.sortOrder),
                  asc(schema.configOptionValue.id),
              )
        : [];

    const valueIds = values.map((row) => row.id);

    const valuePricing = valueIds.length
        ? await db
              .select()
              .from(schema.configOptionPricing)
              .where(inArray(schema.configOptionPricing.valueId, valueIds))
              .orderBy(asc(schema.configOptionPricing.id))
        : [];

    return {
        product,
        group,
        pricing,
        options: options.map((option) => ({
            option,
            values: values
                .filter((value) => value.optionId === option.id)
                .map((value) => ({
                    value,
                    pricing: valuePricing.filter(
                        (row) => row.valueId === value.id,
                    ),
                })),
        })),
    };
}

async function assertProductSlugFree(
    db: Executor,
    slug: string,
    except?: string,
) {
    const [clash] = await db
        .select({ id: schema.product.id })
        .from(schema.product)
        .where(
            except
                ? and(
                      eq(schema.product.slug, slug),
                      ne(schema.product.id, except),
                  )
                : eq(schema.product.slug, slug),
        )
        .limit(1);

    if (clash) {
        throw new CatalogError(`Das Kürzel „${slug}“ ist schon vergeben.`);
    }
}

export async function createProduct(
    db: Db,
    input: ProductInput,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    // Throws before the transaction opens if the module cannot read it.
    const moduleConfig = parseModuleConfig(input.module, input.moduleConfig);

    return db.transaction(async (tx) => {
        await assertProductSlugFree(tx, input.slug);

        const [group] = await tx
            .select({ id: schema.productGroup.id })
            .from(schema.productGroup)
            .where(eq(schema.productGroup.id, input.groupId))
            .limit(1);

        if (!group) {
            throw new CatalogError("Diese Produktgruppe gibt es nicht.");
        }

        const [row] = await tx
            .insert(schema.product)
            .values({ ...input, moduleConfig })
            .returning();

        await audit(tx, {
            actor,
            action: "product.create",
            entityType: "product",
            entityId: row.id,
            after: {
                slug: row.slug,
                name: row.name,
                type: row.type,
                status: row.status,
                module: row.module,
            },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

export async function updateProduct(
    db: Db,
    id: string,
    patch: Partial<ProductInput>,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const before = await getProduct(tx, id);

        if (!before) {
            return null;
        }

        if (patch.slug && patch.slug !== before.slug) {
            await assertProductSlugFree(tx, patch.slug, id);
        }

        const next = { ...patch };

        // The configuration has to be read by whichever module the product
        // ends up with, not the one it had.
        if (patch.module !== undefined || patch.moduleConfig !== undefined) {
            next.moduleConfig = parseModuleConfig(
                patch.module ?? before.module,
                patch.moduleConfig ??
                    (before.moduleConfig as Record<string, unknown>),
            );
        }

        const changes = diff(
            {
                ...(before as unknown as Record<string, unknown>),
                moduleConfig: JSON.stringify(before.moduleConfig ?? {}),
            },
            {
                ...(next as Record<string, unknown>),
                ...(next.moduleConfig === undefined
                    ? {}
                    : { moduleConfig: JSON.stringify(next.moduleConfig) }),
            },
        );

        if (!changes) {
            return before;
        }

        const [row] = await tx
            .update(schema.product)
            .set({ ...next, updatedAt: new Date() })
            .where(eq(schema.product.id, id))
            .returning();

        await audit(tx, {
            actor,
            action: "product.update",
            entityType: "product",
            entityId: id,
            before: changes.before,
            after: changes.after,
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

/**
 * Rule 10: a product is never removed. A subscription item and an invoice
 * line point at it for as long as the books have to be kept, and a catalog
 * row that vanished would turn a paid invoice into a line nobody can explain.
 */
export async function softDeleteProduct(
    db: Db,
    id: string,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const before = await getProduct(tx, id);

        if (!before) {
            return null;
        }

        const now = new Date();

        const [row] = await tx
            .update(schema.product)
            .set({ deletedAt: now, status: "retired", updatedAt: now })
            .where(eq(schema.product.id, id))
            .returning();

        await audit(tx, {
            actor,
            action: "product.delete",
            entityType: "product",
            entityId: id,
            before: { deletedAt: null, status: before.status },
            after: { deletedAt: now.toISOString(), status: "retired" },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

export async function restoreProduct(
    db: Db,
    id: string,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .update(schema.product)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(eq(schema.product.id, id))
            .returning();

        if (!row) {
            return null;
        }

        await audit(tx, {
            actor,
            action: "product.restore",
            entityType: "product",
            entityId: id,
            after: { deletedAt: null, status: row.status },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

/**
 * Replaces a product's whole pricing matrix with exactly these cells. A cell
 * that is not in the list is not offered any more; the matrix is submitted as
 * a whole, so anything else would make "clear this price" impossible to say.
 */
export async function setProductPricing(
    db: Db,
    productId: string,
    cells: ProductPricingInput[],
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const product = await getProduct(tx, productId);

        if (!product) {
            return null;
        }

        const seen = new Set<string>();

        for (const cell of cells) {
            const key = `${cell.cycle}:${cell.currency}`;

            if (seen.has(key)) {
                throw new CatalogError(
                    `Für ${cell.cycle} in ${cell.currency} gibt es zwei Preise.`,
                );
            }

            seen.add(key);
        }

        const before = await tx
            .select()
            .from(schema.productPricing)
            .where(eq(schema.productPricing.productId, productId))
            .orderBy(asc(schema.productPricing.id));

        await tx
            .delete(schema.productPricing)
            .where(eq(schema.productPricing.productId, productId));

        const after = cells.length
            ? await tx
                  .insert(schema.productPricing)
                  .values(cells.map((cell) => ({ ...cell, productId })))
                  .returning()
            : [];

        const summarise = (rows: ProductPricing[]) =>
            Object.fromEntries(
                rows.map((row) => [
                    `${row.cycle}:${row.currency}`,
                    {
                        price: row.priceCents,
                        setup: row.setupFeeCents,
                        trial: row.trialDays,
                    },
                ]),
            );

        const changes = diff(
            { matrix: JSON.stringify(summarise(before)) },
            { matrix: JSON.stringify(summarise(after)) },
        );

        if (changes) {
            await audit(tx, {
                actor,
                action: "product.pricing",
                entityType: "product",
                entityId: productId,
                before: { matrix: summarise(before) },
                after: { matrix: summarise(after) },
                ip: origin?.ip,
                userAgent: origin?.userAgent,
            });
        }

        return after;
    });
}

// --------------------------------------------------------------------------
// Configuration options
// --------------------------------------------------------------------------

export async function createConfigOption(
    db: Db,
    productId: string,
    input: ConfigOptionInput,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const product = await getProduct(tx, productId);

        if (!product) {
            return null;
        }

        const [row] = await tx
            .insert(schema.configOption)
            .values({ ...input, productId })
            .returning();

        await audit(tx, {
            actor,
            action: "config_option.create",
            entityType: "config_option",
            entityId: row.id,
            after: { productId, name: row.name, type: row.type },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

export async function updateConfigOption(
    db: Db,
    id: string,
    patch: Partial<ConfigOptionInput>,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(schema.configOption)
            .where(eq(schema.configOption.id, id))
            .limit(1);

        if (!before) {
            return null;
        }

        const changes = diff(
            before as unknown as Record<string, unknown>,
            patch as Record<string, unknown>,
        );

        if (!changes) {
            return before;
        }

        const [row] = await tx
            .update(schema.configOption)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(schema.configOption.id, id))
            .returning();

        await audit(tx, {
            actor,
            action: "config_option.update",
            entityType: "config_option",
            entityId: id,
            before: changes.before,
            after: changes.after,
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

export async function deleteConfigOption(
    db: Db,
    id: string,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(schema.configOption)
            .where(eq(schema.configOption.id, id))
            .limit(1);

        if (!before) {
            return null;
        }

        await tx
            .delete(schema.configOption)
            .where(eq(schema.configOption.id, id));

        await audit(tx, {
            actor,
            action: "config_option.delete",
            entityType: "config_option",
            entityId: id,
            before: { productId: before.productId, name: before.name },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return before;
    });
}

/**
 * Replaces an option's values and their prices with exactly this list. Values
 * carrying an id keep it, so an order that already references one keeps
 * pointing at the same row; anything missing from the list is removed.
 */
export async function setConfigOptionValues(
    db: Db,
    optionId: string,
    values: ConfigOptionValueInput[],
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const [option] = await tx
            .select()
            .from(schema.configOption)
            .where(eq(schema.configOption.id, optionId))
            .limit(1);

        if (!option) {
            return null;
        }

        if (values.filter((value) => value.isDefault).length > 1) {
            throw new CatalogError(
                "Nur ein Wert kann die Voreinstellung sein.",
            );
        }

        const existing = await tx
            .select()
            .from(schema.configOptionValue)
            .where(eq(schema.configOptionValue.optionId, optionId));

        const keep = new Set(
            values.map((value) => value.id).filter((id): id is string => !!id),
        );

        for (const row of existing) {
            if (!keep.has(row.id)) {
                await tx
                    .delete(schema.configOptionValue)
                    .where(eq(schema.configOptionValue.id, row.id));
            }
        }

        const saved: ConfigOptionValue[] = [];

        for (const [position, value] of values.entries()) {
            const fields = {
                name: value.name,
                sortOrder: value.sortOrder || position,
                isDefault: value.isDefault,
            };

            const [row] =
                value.id && existing.some((entry) => entry.id === value.id)
                    ? await tx
                          .update(schema.configOptionValue)
                          .set({ ...fields, updatedAt: new Date() })
                          .where(eq(schema.configOptionValue.id, value.id))
                          .returning()
                    : await tx
                          .insert(schema.configOptionValue)
                          .values({ ...fields, optionId })
                          .returning();

            saved.push(row);

            await tx
                .delete(schema.configOptionPricing)
                .where(eq(schema.configOptionPricing.valueId, row.id));

            if (value.pricing.length) {
                await tx.insert(schema.configOptionPricing).values(
                    value.pricing.map((cell) => ({
                        ...cell,
                        valueId: row.id,
                    })),
                );
            }
        }

        await audit(tx, {
            actor,
            action: "config_option.values",
            entityType: "config_option",
            entityId: optionId,
            before: {
                values: existing.map((row) => row.name),
            },
            after: {
                values: saved.map((row) => row.name),
            },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return saved;
    });
}

// --------------------------------------------------------------------------
// Coupons
// --------------------------------------------------------------------------

export async function listCoupons(db: Executor) {
    return db.select().from(schema.coupon).orderBy(asc(schema.coupon.code));
}

export async function getCoupon(db: Executor, id: string) {
    const [row] = await db
        .select()
        .from(schema.coupon)
        .where(eq(schema.coupon.id, id))
        .limit(1);

    return row ?? null;
}

/** Codes are stored upper case, so what the customer typed does not matter. */
export async function getCouponByCode(db: Executor, code: string) {
    const [row] = await db
        .select()
        .from(schema.coupon)
        .where(eq(schema.coupon.code, code.trim().toUpperCase()))
        .limit(1);

    return row ?? null;
}

function couponFields(input: CouponInput) {
    return {
        code: input.code,
        description: input.description ?? null,
        kind: input.kind,
        percentBasisPoints:
            input.kind === "percent" ? input.percentBasisPoints : null,
        amountCents: input.kind === "fixed" ? input.amountCents : null,
        currency: input.kind === "fixed" ? input.currency : null,
        duration: input.duration,
        durationPeriods:
            input.duration === "repeating" ? input.durationPeriods : null,
        appliesToSetupFee: input.appliesToSetupFee,
        productIds: input.productIds,
        cycles: input.cycles,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        maxRedemptions: input.maxRedemptions,
        active: input.active,
    };
}

export async function createCoupon(
    db: Db,
    input: CouponInput,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const clash = await getCouponByCode(tx, input.code);

        if (clash) {
            throw new CatalogError(`Den Code „${input.code}“ gibt es schon.`);
        }

        const [row] = await tx
            .insert(schema.coupon)
            .values(couponFields(input))
            .returning();

        await audit(tx, {
            actor,
            action: "coupon.create",
            entityType: "coupon",
            entityId: row.id,
            after: {
                code: row.code,
                kind: row.kind,
                duration: row.duration,
                active: row.active,
            },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

export async function updateCoupon(
    db: Db,
    id: string,
    input: CouponInput,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const before = await getCoupon(tx, id);

        if (!before) {
            return null;
        }

        const clash = await getCouponByCode(tx, input.code);

        if (clash && clash.id !== id) {
            throw new CatalogError(`Den Code „${input.code}“ gibt es schon.`);
        }

        const fields = couponFields(input);

        const changes = diff(
            {
                ...(before as unknown as Record<string, unknown>),
                productIds: before.productIds.join(","),
                cycles: before.cycles.join(","),
                validFrom: before.validFrom?.toISOString() ?? null,
                validUntil: before.validUntil?.toISOString() ?? null,
            },
            {
                ...(fields as unknown as Record<string, unknown>),
                productIds: fields.productIds.join(","),
                cycles: fields.cycles.join(","),
                validFrom: fields.validFrom?.toISOString() ?? null,
                validUntil: fields.validUntil?.toISOString() ?? null,
            },
        );

        if (!changes) {
            return before;
        }

        const [row] = await tx
            .update(schema.coupon)
            .set({ ...fields, updatedAt: new Date() })
            .where(eq(schema.coupon.id, id))
            .returning();

        await audit(tx, {
            actor,
            action: "coupon.update",
            entityType: "coupon",
            entityId: id,
            before: changes.before,
            after: changes.after,
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

export async function deleteCoupon(
    db: Db,
    id: string,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const before = await getCoupon(tx, id);

        if (!before) {
            return null;
        }

        if (before.redemptions > 0) {
            throw new CatalogError(
                "Dieser Code wurde schon eingelöst. Er lässt sich abschalten, aber nicht löschen.",
            );
        }

        await tx.delete(schema.coupon).where(eq(schema.coupon.id, id));

        await audit(tx, {
            actor,
            action: "coupon.delete",
            entityType: "coupon",
            entityId: id,
            before: { code: before.code, kind: before.kind },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return before;
    });
}

/** The coupon shape `calculateQuote` takes, straight from the row. */
export function toQuoteCoupon(row: Coupon) {
    return {
        id: row.id,
        code: row.code,
        kind: row.kind,
        percentBasisPoints: row.percentBasisPoints,
        amountCents: row.amountCents,
        currency: row.currency,
        duration: row.duration,
        durationPeriods: row.durationPeriods,
        appliesToSetupFee: row.appliesToSetupFee,
        productIds: row.productIds,
        cycles: row.cycles,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        maxRedemptions: row.maxRedemptions,
        redemptions: row.redemptions,
        active: row.active,
    };
}

/** The cycles a product is actually sold in, for the storefront's selector. */
export function cyclesOffered(
    pricing: ProductPricing[],
    currency: string,
): BillingCycle[] {
    const order: BillingCycle[] = [
        "monthly",
        "quarterly",
        "semiannual",
        "annual",
        "biennial",
        "onetime",
    ];

    return order.filter((cycle) =>
        pricing.some((row) => row.cycle === cycle && row.currency === currency),
    );
}
