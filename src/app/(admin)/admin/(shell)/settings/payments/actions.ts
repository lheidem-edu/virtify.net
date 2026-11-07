"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import type { Actor } from "@/server/audit";
import { audit } from "@/server/audit";
import { requirePermission } from "@/server/auth/staff-session";
import {
    type GatewayId,
    type GatewayMode,
    gatewayConfig,
    mergeCredentials,
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

    /**
     * Per field, not per gateway.
     *
     * The form says so on every secret — "gespeichert — leer lassen, um ihn
     * zu behalten" — but the old reading was all-or-nothing: typing a new
     * Stripe secret key and leaving the webhook secret blank wrote the pair
     * `{ new key, "" }`, and the webhook route then answered every delivery
     * 503. Rotating a PayPal client secret blanked the webhook id the same
     * way, which stops `CHECKOUT.ORDER.APPROVED` arriving and leaves an
     * approved order uncaptured until PayPal voids it.
     *
     * So each field falls back to what is stored. `clear` below is still the
     * only way to empty them.
     */
    const stored = (await gatewayConfig(id)).credentials as Record<
        string,
        string | undefined
    >;

    const merge = (fields: string[]) =>
        mergeCredentials(
            fields,
            Object.fromEntries(fields.map((field) => [field, read(field)])),
            stored,
        );

    if (id === "stripe") {
        credentials = merge(["secretKey", "webhookSecret"]);
    }

    if (id === "paypal") {
        credentials = merge(["clientId", "clientSecret", "webhookId"]);
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
