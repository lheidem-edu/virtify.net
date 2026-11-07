"use server";

import { revalidatePath } from "next/cache";
import type { ApiKeyState } from "@/components/shared/api-key-manager";
import { db } from "@/db";
import { createApiKey, revokeApiKey } from "@/server/api-keys";
import { requestOrigin } from "@/server/audit/request";
import {
    hasPermission,
    PERMISSIONS,
    type Permission,
} from "@/server/auth/permissions";
import {
    currentStaffPermissions,
    requirePermission,
} from "@/server/auth/staff-session";

function readScopes(data: FormData): Permission[] {
    return data
        .getAll("scopes")
        .map(String)
        .filter((scope): scope is Permission => scope in PERMISSIONS);
}

/**
 * A key can never be more than the employee who made it. The scopes are
 * checked against their own permissions here as well as at every request, so
 * a key that outlives a demotion still shrinks with it.
 */
export async function createStaffKey(
    _previous: ApiKeyState,
    data: FormData,
): Promise<ApiKeyState> {
    const session = await requirePermission("apikeys.manage");

    const name = String(data.get("name") ?? "").trim();
    const scopes = readScopes(data);

    if (!name) {
        return { status: "error", message: "Bitte gib eine Bezeichnung an." };
    }

    if (scopes.length === 0) {
        return {
            status: "error",
            message: "Wähle mindestens eine Berechtigung.",
        };
    }

    const own = await currentStaffPermissions();
    const beyond = scopes.filter((scope) => !hasPermission(own, scope));

    if (beyond.length > 0) {
        return {
            status: "error",
            message: `Diese Berechtigungen hast du selbst nicht: ${beyond.join(", ")}.`,
        };
    }

    const { token } = await createApiKey(
        db,
        {
            name,
            scopes,
            owner: { type: "staff", staffUserId: session.user.id },
        },
        { type: "staff", id: session.user.id, label: session.user.email },
        await requestOrigin(),
    );

    revalidatePath("/admin/api-keys");

    return { status: "created", token };
}

export async function revokeStaffKey(
    _previous: ApiKeyState,
    data: FormData,
): Promise<ApiKeyState> {
    const session = await requirePermission("apikeys.manage");

    const row = await revokeApiKey(
        db,
        String(data.get("keyId") ?? ""),
        { type: "staff", staffUserId: session.user.id },
        { type: "staff", id: session.user.id, label: session.user.email },
        await requestOrigin(),
    );

    revalidatePath("/admin/api-keys");

    return row
        ? { status: "revoked" }
        : {
              status: "error",
              message:
                  "Diesen Schlüssel gibt es nicht oder er ist schon widerrufen.",
          };
}
