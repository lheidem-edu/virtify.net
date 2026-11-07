"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/db";
import { requirePermission } from "@/server/auth/staff-session";
import { decideOrder, type OrderDecision } from "@/server/orders/repository";
import { OrderError } from "@/server/orders/service";

/**
 * Accepting, cancelling or refusing an order. Thin by design: the rules —
 * what a decision does to the subscriptions and the services it created —
 * live in `src/server/orders/repository.ts`, which the tests drive directly.
 */

export type OrderActionState = {
    status: "idle" | "done" | "error";
    message?: string;
};

const DECISIONS: Record<OrderDecision, string> = {
    accept: "Die Bestellung ist angenommen.",
    cancel: "Die Bestellung ist storniert.",
    fraud: "Die Bestellung ist als Betrug markiert.",
};

export async function decide(
    _previous: OrderActionState,
    data: FormData,
): Promise<OrderActionState> {
    const session = await requirePermission("orders.write");

    const orderId = String(data.get("orderId") ?? "");
    const decision = String(data.get("decision") ?? "") as OrderDecision;

    if (!(decision in DECISIONS)) {
        return { status: "error", message: "Unbekannte Entscheidung." };
    }

    await headers();

    try {
        await decideOrder(
            db,
            orderId,
            decision,
            {
                type: "staff",
                id: session.user.id,
                label: session.user.email,
            },
            {
                reason: String(data.get("reason") ?? "") || null,
            },
        );
    } catch (error) {
        if (error instanceof OrderError) {
            return { status: "error", message: error.message };
        }

        throw error;
    }

    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath("/admin/orders");

    return { status: "done", message: DECISIONS[decision] };
}
