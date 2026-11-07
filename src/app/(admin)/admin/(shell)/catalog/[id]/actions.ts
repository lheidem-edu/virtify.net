"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import {
    CatalogError,
    createConfigOption,
    deleteConfigOption,
    setConfigOptionValues,
    setProductPricing,
    updateConfigOption,
    updateProduct,
} from "@/server/catalog/repository";
import {
    billingCycleSchema,
    type ConfigOptionValueInput,
    configOptionInputSchema,
    configOptionValueInputSchema,
    type ProductPricingInput,
    productInputSchema,
    productPricingInputSchema,
    slugify,
} from "@/server/catalog/schema";
import { ModuleConfigError, UnknownModuleError } from "@/server/provisioning";
import type { CatalogState } from "../actions";
import { cents, flag, integer, optional, text } from "../form";
import { CYCLES, labelFor } from "../labels";

export type { CatalogState };

async function actor() {
    const session = await requirePermission("catalog.write");

    return {
        actor: {
            type: "staff" as const,
            id: session.user.id,
            label: session.user.email,
        },
        origin: await requestOrigin(),
    };
}

function message(error: unknown): string | null {
    if (
        error instanceof CatalogError ||
        error instanceof ModuleConfigError ||
        error instanceof UnknownModuleError
    ) {
        return error.message;
    }

    return null;
}

function refresh(productId: string) {
    revalidatePath("/admin/catalog");
    revalidatePath(`/admin/catalog/${productId}`);
    revalidatePath("/products");
}

export async function saveProduct(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");

    if (!productId) {
        return { status: "error", message: "Kein Produkt angegeben." };
    }

    const name = text(data, "name");
    const rawConfig = text(data, "moduleConfig");

    let moduleConfig: Record<string, unknown>;

    try {
        moduleConfig = rawConfig ? JSON.parse(rawConfig) : {};
    } catch {
        return {
            status: "error",
            message: "Die Moduleinstellungen sind kein gültiges JSON.",
        };
    }

    const parsed = productInputSchema.safeParse({
        groupId: text(data, "groupId"),
        slug: text(data, "slug") || slugify(name),
        name,
        type: optional(data, "type") ?? "other",
        status: optional(data, "status") ?? "draft",
        tagline: optional(data, "tagline") ?? "",
        description: optional(data, "description") ?? "",
        sortOrder: integer(data, "sortOrder", 0),
        module: optional(data, "module") ?? "none",
        moduleConfig,
        maxQuantity: integer(data, "maxQuantity", 1),
        provisioningMode: optional(data, "provisioningMode") ?? "manual",
    });

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    try {
        const row = await updateProduct(
            db,
            productId,
            parsed.data,
            who,
            origin,
        );

        if (!row) {
            return {
                status: "error",
                message: "Dieses Produkt gibt es nicht.",
            };
        }
    } catch (error) {
        const said = message(error);

        if (!said) {
            throw error;
        }

        return { status: "error", message: said };
    }

    refresh(productId);

    return { status: "saved" };
}

/**
 * The matrix is submitted whole: every cell the form knows about is read, and
 * a cell left empty is a combination that is not offered. Replacing the lot
 * is the only way "stop selling this yearly" can be said with a form.
 */
export async function savePricing(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");
    const currencies = text(data, "currencies").split(",").filter(Boolean);
    const cells: ProductPricingInput[] = [];

    for (const cycle of billingCycleSchema.options) {
        for (const currency of currencies) {
            const price = cents(data, `price-${cycle}-${currency}`);

            // An empty price is the cell saying it is not for sale. A field
            // that was filled in but cannot be read is an error, not a zero.
            if (price === null) {
                if (text(data, `price-${cycle}-${currency}`) !== "") {
                    return {
                        status: "error",
                        message: `Der Preis für „${labelFor(CYCLES, cycle)}“ in ${currency} ist keine Zahl.`,
                    };
                }

                continue;
            }

            const setup = cents(data, `setup-${cycle}-${currency}`) ?? 0;

            const parsed = productPricingInputSchema.safeParse({
                cycle,
                currency,
                priceCents: price,
                setupFeeCents: setup,
                trialDays: integer(data, `trial-${cycle}-${currency}`, 0),
            });

            if (!parsed.success) {
                return {
                    status: "error",
                    message: `${cycle} / ${currency}: ${
                        parsed.error.issues[0]?.message ?? "ungültig"
                    }`,
                };
            }

            cells.push(parsed.data);
        }
    }

    try {
        const rows = await setProductPricing(db, productId, cells, who, origin);

        if (!rows) {
            return {
                status: "error",
                message: "Dieses Produkt gibt es nicht.",
            };
        }
    } catch (error) {
        const said = message(error);

        if (!said) {
            throw error;
        }

        return { status: "error", message: said };
    }

    refresh(productId);

    return { status: "saved" };
}

function readOption(data: FormData) {
    return {
        name: text(data, "name"),
        description: optional(data, "description") ?? "",
        type: optional(data, "type") ?? "select",
        required: flag(data, "required"),
        sortOrder: integer(data, "sortOrder", 0),
        minQuantity: integer(data, "minQuantity", 0),
        maxQuantity: integer(data, "maxQuantity", 10),
    };
}

export async function addOption(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");
    const parsed = configOptionInputSchema.safeParse(readOption(data));

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    const row = await createConfigOption(
        db,
        productId,
        parsed.data,
        who,
        origin,
    );

    if (!row) {
        return { status: "error", message: "Dieses Produkt gibt es nicht." };
    }

    refresh(productId);

    return { status: "saved" };
}

export async function saveOption(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");
    const parsed = configOptionInputSchema.safeParse(readOption(data));

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    const row = await updateConfigOption(
        db,
        text(data, "optionId"),
        parsed.data,
        who,
        origin,
    );

    if (!row) {
        return { status: "error", message: "Diese Option gibt es nicht." };
    }

    refresh(productId);

    return { status: "saved" };
}

export async function removeOption(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");

    const row = await deleteConfigOption(
        db,
        text(data, "optionId"),
        who,
        origin,
    );

    if (!row) {
        return { status: "error", message: "Diese Option gibt es nicht." };
    }

    refresh(productId);

    return { status: "saved" };
}

/**
 * The values of one option, with their prices, submitted as a whole for the
 * same reason the pricing matrix is. A row whose name is empty is dropped,
 * which is how the two blank rows at the bottom stay optional.
 */
export async function saveOptionValues(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");
    const optionId = text(data, "optionId");
    const rows = integer(data, "rowCount", 0);
    const cycles = text(data, "cycles").split(",").filter(Boolean);
    const currencies = text(data, "currencies").split(",").filter(Boolean);
    const defaultRow = text(data, "defaultRow");

    const values: ConfigOptionValueInput[] = [];

    for (let index = 0; index < rows; index += 1) {
        const name = text(data, `value-${index}-name`);

        if (name === "") {
            continue;
        }

        const pricing: ConfigOptionValueInput["pricing"] = [];

        for (const cycle of cycles) {
            for (const currency of currencies) {
                const priceField = `value-${index}-price-${cycle}-${currency}`;
                const setupField = `value-${index}-setup-${cycle}-${currency}`;
                const price = cents(data, priceField);
                const setup = cents(data, setupField);

                // Empty means no surcharge. A field that was filled in but
                // cannot be read is an error, not a zero — the pricing matrix
                // above guards exactly this, and storing 0 here would wipe the
                // surcharge the operator was trying to correct.
                for (const [field, value] of [
                    [priceField, price],
                    [setupField, setup],
                ] as const) {
                    if (value === null && text(data, field) !== "") {
                        return {
                            status: "error",
                            message: `„${text(data, `value-${index}-name`)}“: „${text(data, field)}“ ist keine Zahl.`,
                        };
                    }
                }

                if ((price ?? 0) === 0 && (setup ?? 0) === 0) {
                    continue;
                }

                pricing.push({
                    cycle: cycle as (typeof billingCycleSchema.options)[number],
                    currency,
                    priceCents: price ?? 0,
                    setupFeeCents: setup ?? 0,
                });
            }
        }

        const parsed = configOptionValueInputSchema.safeParse({
            id: text(data, `value-${index}-id`) || undefined,
            name,
            sortOrder: index,
            isDefault: defaultRow === String(index),
            pricing,
        });

        if (!parsed.success) {
            return {
                status: "error",
                message: `${name}: ${
                    parsed.error.issues[0]?.message ?? "ungültig"
                }`,
            };
        }

        values.push(parsed.data);
    }

    try {
        const saved = await setConfigOptionValues(
            db,
            optionId,
            values,
            who,
            origin,
        );

        if (!saved) {
            return { status: "error", message: "Diese Option gibt es nicht." };
        }
    } catch (error) {
        const said = message(error);

        if (!said) {
            throw error;
        }

        return { status: "error", message: said };
    }

    refresh(productId);

    return { status: "saved" };
}
