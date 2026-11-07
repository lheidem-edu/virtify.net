"use server";

import { revalidatePath } from "next/cache";
import type { ApiKeyState } from "@/components/shared/api-key-manager";
import { db } from "@/db";
import {
    CUSTOMER_SCOPES,
    type CustomerScope,
    createApiKey,
    revokeApiKey,
} from "@/server/api-keys";
import { requestOrigin } from "@/server/audit/request";
import { getCurrentCustomer } from "@/server/customers/current";

function readScopes(data: FormData): CustomerScope[] {
    return data
        .getAll("scopes")
        .map(String)
        .filter((scope): scope is CustomerScope =>
            (CUSTOMER_SCOPES as readonly string[]).includes(scope),
        );
}

export async function createCustomerKey(
    _previous: ApiKeyState,
    data: FormData,
): Promise<ApiKeyState> {
    const { customer, contact, user } = await getCurrentCustomer();

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

    const { token } = await createApiKey(
        db,
        {
            name,
            scopes,
            owner: { type: "customer", customerId: customer.id },
        },
        { type: "customer", id: user.id, label: contact.email },
        await requestOrigin(),
    );

    revalidatePath("/client/api-keys");

    return { status: "created", token };
}

export async function revokeCustomerKey(
    _previous: ApiKeyState,
    data: FormData,
): Promise<ApiKeyState> {
    const { customer, contact, user } = await getCurrentCustomer();

    const row = await revokeApiKey(
        db,
        String(data.get("keyId") ?? ""),
        { type: "customer", customerId: customer.id },
        { type: "customer", id: user.id, label: contact.email },
        await requestOrigin(),
    );

    revalidatePath("/client/api-keys");

    return row
        ? { status: "revoked" }
        : {
              status: "error",
              message:
                  "Diesen Schlüssel gibt es nicht oder er ist schon widerrufen.",
          };
}
