"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { berlinInstant } from "@/lib/berlin-date";
import type { Actor } from "@/server/audit";
import { requirePermission } from "@/server/auth/staff-session";
import {
    cancelScheduledTaxMode,
    scheduleTaxMode,
    TaxModeError,
} from "@/server/tax/mode";

export type TaxModeState = {
    status: "idle" | "scheduled" | "cancelled" | "error";
    message?: string;
};

async function actor(): Promise<Actor> {
    const session = await requirePermission("settings.write");

    return { type: "staff", id: session.user.id, label: session.user.email };
}

export async function scheduleTaxSwitch(
    _previous: TaxModeState,
    data: FormData,
): Promise<TaxModeState> {
    const who = await actor();

    const strategy = String(data.get("strategy") ?? "");
    // A tax switch takes effect at midnight *local* time; read as UTC it
    // would start an hour or two early and catch the invoices of the
    // evening before.
    const effectiveFrom = berlinInstant(
        String(data.get("effectiveFrom") ?? ""),
    );
    const note = String(data.get("note") ?? "");

    // The second half of the confirmation. The first is the dialog; this is
    // the box the operator has to tick inside it, because the consequence —
    // every invoice from that date on carries a different tax — is not
    // visible anywhere until it has already happened.
    if (data.get("understood") !== "yes") {
        return {
            status: "error",
            message:
                "Bitte bestätigen Sie, dass die Umstellung ab dem Stichtag für alle dann ausgestellten Rechnungen gilt.",
        };
    }

    if (!effectiveFrom) {
        return { status: "error", message: "Bitte ein gültiges Datum wählen." };
    }

    try {
        await scheduleTaxMode(db, { strategy, effectiveFrom, note }, who);
    } catch (error) {
        if (error instanceof TaxModeError) {
            return { status: "error", message: error.message };
        }

        console.error("[admin] scheduling the tax switch failed:", error);

        return {
            status: "error",
            message: "Die Umstellung konnte nicht geplant werden.",
        };
    }

    revalidatePath("/admin/settings/tax");

    return { status: "scheduled", message: "Die Umstellung ist geplant." };
}

export async function cancelTaxSwitch(
    _previous: TaxModeState,
    data: FormData,
): Promise<TaxModeState> {
    const who = await actor();

    try {
        await cancelScheduledTaxMode(db, String(data.get("id") ?? ""), who);
    } catch (error) {
        if (error instanceof TaxModeError) {
            return { status: "error", message: error.message };
        }

        console.error("[admin] cancelling the tax switch failed:", error);

        return {
            status: "error",
            message: "Die Umstellung konnte nicht zurückgenommen werden.",
        };
    }

    revalidatePath("/admin/settings/tax");

    return {
        status: "cancelled",
        message: "Die Umstellung ist zurückgenommen.",
    };
}
