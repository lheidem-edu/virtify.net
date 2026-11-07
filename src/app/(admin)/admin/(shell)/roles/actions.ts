"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import type { Permission } from "@/server/auth/permissions";
import { PERMISSIONS } from "@/server/auth/permissions";
import {
    createRole,
    deleteRole,
    RoleError,
    setRoles,
    updateRolePermissions,
} from "@/server/auth/roles";
import { requirePermission } from "@/server/auth/staff-session";

export type RoleState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

function scopes(data: FormData): Permission[] {
    return data
        .getAll("permissions")
        .map(String)
        .filter((entry): entry is Permission => entry in PERMISSIONS);
}

async function actor() {
    const session = await requirePermission("roles.manage");

    return {
        session,
        who: {
            type: "staff" as const,
            id: session.user.id,
            label: session.user.email,
        },
    };
}

export async function addRole(
    _previous: RoleState,
    data: FormData,
): Promise<RoleState> {
    const { who } = await actor();
    const name = String(data.get("name") ?? "").trim();

    if (!name) {
        return { status: "error", message: "Die Rolle braucht einen Namen." };
    }

    try {
        await createRole(
            db,
            {
                name,
                description:
                    String(data.get("description") ?? "").trim() || null,
                permissions: scopes(data),
            },
            who,
        );
    } catch (error) {
        return {
            status: "error",
            message:
                error instanceof RoleError
                    ? error.message
                    : "Diesen Namen gibt es schon.",
        };
    }

    revalidatePath("/admin/roles");

    return { status: "saved" };
}

export async function saveRole(
    _previous: RoleState,
    data: FormData,
): Promise<RoleState> {
    const { who } = await actor();

    try {
        await updateRolePermissions(
            db,
            String(data.get("roleId") ?? ""),
            scopes(data),
            who,
        );
    } catch (error) {
        return {
            status: "error",
            message:
                error instanceof RoleError
                    ? error.message
                    : "Die Rolle konnte nicht gespeichert werden.",
        };
    }

    revalidatePath("/admin/roles");

    return { status: "saved" };
}

export async function removeRole(
    _previous: RoleState,
    data: FormData,
): Promise<RoleState> {
    const { who } = await actor();

    try {
        await deleteRole(db, String(data.get("roleId") ?? ""), who);
    } catch (error) {
        return {
            status: "error",
            message:
                error instanceof RoleError
                    ? error.message
                    : "Die Rolle konnte nicht gelöscht werden.",
        };
    }

    revalidatePath("/admin/roles");

    return { status: "saved" };
}

/** Replaces one employee's roles with exactly what was ticked. */
export async function assignRoles(
    _previous: RoleState,
    data: FormData,
): Promise<RoleState> {
    const { who } = await actor();

    try {
        await setRoles(
            db,
            String(data.get("staffUserId") ?? ""),
            data.getAll("roleIds").map(String).filter(Boolean),
            who,
        );
    } catch (error) {
        return {
            status: "error",
            message:
                error instanceof RoleError
                    ? error.message
                    : "Die Rollen konnten nicht geändert werden.",
        };
    }

    revalidatePath("/admin/roles");
    revalidatePath("/admin/staff");

    return { status: "saved" };
}
