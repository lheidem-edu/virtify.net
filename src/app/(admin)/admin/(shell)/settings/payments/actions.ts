"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import type { Actor } from "@/server/audit";
import { audit } from "@/server/audit";
import { requirePermission } from "@/server/auth/staff-session";
import {
    type GatewayId,
    type GatewayMode,
    type PayPalRecurringMode,
    saveGatewayConfig,
} from "@/server/payments/settings";

export type GatewaySettingsState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

/**
 * Saves one gateway's configuration.
 *
 * Hard rule 6: the credentials are encrypted on the way in
 * (`saveGatewayConfig` → `src/lib/crypto.ts`) and are never read back into a
 * form. An empty secret field therefore means "leave what is stored alone",
 * not "clear it" — the operator cannot re-type what they cannot see, and a
 * blank save that silently wiped the keys would take payments down.
 *
 * Nothing secret reaches the audit entry. What is recorded is that the
 * credentials changed, not what they changed to.
 */
export async function saveGatewaySettings(
    _previous: GatewaySettingsState,
    data: FormData,
): Promise<GatewaySettingsState> {
    const session = await requirePermission("settings.write");

    const actor: Actor = {
        type: "staff",
        id: session.user.id,
        label: session.user.email,
    };

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const id = read("gateway") as GatewayId;

    if (id !== "stripe" && id !== "paypal" && id !== "banktransfer") {
        return { status: "error", message: "Unbekannte Zahlungsart." };
    }

    const enabled = read("enabled") === "on";
    const mode: GatewayMode = read("mode") === "live" ? "live" : "sandbox";

    const recurring = read("paypalRecurringMode");
    const paypalRecurringMode: PayPalRecurringMode | undefined =
        id === "paypal"
            ? recurring === "vault"
                ? "vault"
                : "subscriptions"
            : undefined;

    let credentials: Record<string, string> | null | undefined;

    if (id === "stripe") {
        const secretKey = read("secretKey");
        const webhookSecret = read("webhookSecret");

        credentials =
            secretKey || webhookSecret
                ? { secretKey, webhookSecret }
                : undefined;
    }

    if (id === "paypal") {
        const clientId = read("clientId");
        const clientSecret = read("clientSecret");
        const webhookId = read("webhookId");

        credentials =
            clientId || clientSecret || webhookId
                ? { clientId, clientSecret, webhookId }
                : undefined;
    }

    if (read("clear") === "on") {
        // Back to the environment. The explicit choice, not an empty field.
        credentials = null;
    }

    try {
        await db.transaction(async (tx) => {
            await saveGatewayConfig(tx, id, {
                enabled,
                mode,
                paypalRecurringMode,
                credentials: credentials as never,
            });

            await audit(tx, {
                actor,
                action: "payment_gateway.update",
                entityType: "payment_gateway_setting",
                entityId: id,
                after: {
                    enabled,
                    mode,
                    paypalRecurringMode: paypalRecurringMode ?? null,
                    // Deliberately only whether they moved.
                    credentials:
                        credentials === undefined
                            ? "unverändert"
                            : credentials === null
                              ? "gelöscht"
                              : "ersetzt",
                },
            });
        });
    } catch (error) {
        console.error("[admin] saving the gateway settings failed:", error);

        return {
            status: "error",
            message: "Das konnte nicht gespeichert werden.",
        };
    }

    revalidatePath("/admin/settings/payments");
    revalidatePath("/client/invoices");

    return { status: "saved", message: "Gespeichert." };
}
