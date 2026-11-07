"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import {
    CatalogError,
    createGroup,
    createProduct,
    deleteGroup,
    moveGroup,
    restoreProduct,
    softDeleteProduct,
    updateGroup,
} from "@/server/catalog/repository";
import {
    productGroupInputSchema,
    productInputSchema,
    slugify,
} from "@/server/catalog/schema";
import { ModuleConfigError, UnknownModuleError } from "@/server/provisioning";
import { flag, integer, optional, text } from "./form";

export type CatalogState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

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

/** Service errors that are the operator's to fix, not a bug to swallow. */
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

function readGroup(data: FormData) {
    const name = text(data, "name");

    return {
        // An empty slug is derived from the name, so the operator only has to
        // fill one of the two and the storefront address is never blank.
        slug: text(data, "slug") || slugify(name),
        name,
        tagline: optional(data, "tagline") ?? "",
        description: optional(data, "description") ?? "",
        sortOrder: integer(data, "sortOrder", 0),
        hidden: flag(data, "hidden"),
    };
}

export async function addGroup(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const parsed = productGroupInputSchema.safeParse(readGroup(data));

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    try {
        await createGroup(db, parsed.data, who, origin);
    } catch (error) {
        const said = message(error);

        if (!said) {
            throw error;
        }

        return { status: "error", message: said };
    }

    revalidatePath("/admin/catalog");
    revalidatePath("/products");

    return { status: "saved" };
}

export async function saveGroup(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const groupId = text(data, "groupId");

    if (!groupId) {
        return { status: "error", message: "Keine Gruppe angegeben." };
    }

    const parsed = productGroupInputSchema.safeParse(readGroup(data));

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    try {
        const row = await updateGroup(db, groupId, parsed.data, who, origin);

        if (!row) {
            return { status: "error", message: "Diese Gruppe gibt es nicht." };
        }
    } catch (error) {
        const said = message(error);

        if (!said) {
            throw error;
        }

        return { status: "error", message: said };
    }

    revalidatePath("/admin/catalog");
    revalidatePath("/products");

    return { status: "saved" };
}

export async function removeGroup(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();

    try {
        const row = await deleteGroup(db, text(data, "groupId"), who, origin);

        if (!row) {
            return { status: "error", message: "Diese Gruppe gibt es nicht." };
        }
    } catch (error) {
        const said = message(error);

        if (!said) {
            throw error;
        }

        return { status: "error", message: said };
    }

    revalidatePath("/admin/catalog");
    revalidatePath("/products");

    return { status: "saved" };
}

export async function reorderGroup(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const direction = text(data, "direction") === "up" ? "up" : "down";

    await moveGroup(db, text(data, "groupId"), direction, who, origin);

    revalidatePath("/admin/catalog");
    revalidatePath("/products");

    return { status: "saved" };
}

export async function addProduct(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const name = text(data, "name");

    const parsed = productInputSchema.safeParse({
        groupId: text(data, "groupId"),
        slug: text(data, "slug") || slugify(name),
        name,
        type: optional(data, "type") ?? "other",
        status: optional(data, "status") ?? "draft",
        tagline: optional(data, "tagline") ?? "",
        description: "",
        sortOrder: integer(data, "sortOrder", 0),
        module: optional(data, "module") ?? "none",
        moduleConfig: {},
        maxQuantity: integer(data, "maxQuantity", 1),
    });

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    let id: string;

    try {
        id = (await createProduct(db, parsed.data, who, origin)).id;
    } catch (error) {
        const said = message(error);

        if (!said) {
            throw error;
        }

        return { status: "error", message: said };
    }

    revalidatePath("/admin/catalog");

    // Outside the try/catch above by construction: redirect() throws.
    redirect(`/admin/catalog/${id}`);
}

export async function removeProduct(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");

    const row = await softDeleteProduct(db, productId, who, origin);

    if (!row) {
        return { status: "error", message: "Dieses Produkt gibt es nicht." };
    }

    revalidatePath("/admin/catalog");
    revalidatePath(`/admin/catalog/${productId}`);
    revalidatePath("/products");

    return { status: "saved" };
}

export async function undeleteProduct(
    _previous: CatalogState,
    data: FormData,
): Promise<CatalogState> {
    const { actor: who, origin } = await actor();
    const productId = text(data, "productId");

    const row = await restoreProduct(db, productId, who, origin);

    if (!row) {
        return { status: "error", message: "Dieses Produkt gibt es nicht." };
    }

    revalidatePath("/admin/catalog");
    revalidatePath(`/admin/catalog/${productId}`);

    return { status: "saved" };
}
