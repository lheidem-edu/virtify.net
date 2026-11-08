"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { CatalogError } from "@/server/catalog/repository";
import { getCurrentCustomer } from "@/server/customers/current";
import {
    applyChange,
    describePreview,
    previewChange,
} from "@/server/subscriptions/changes";
import { loadSubscription } from "@/server/subscriptions/repository";
import {
    cancelSubscription,
    resumeCancellation,
    SubscriptionError,
} from "@/server/subscriptions/service";
import { SubscriptionStateError } from "@/server/subscriptions/state";

/**
 * What a customer may do to their own Abo.
 *
 * `getCurrentCustomer()` is the only thing that says whose rows these are
 * (rule 5), and every action re-reads the subscription **through it** before
 * touching anything — the id in the form is a request, not a credential.
 *
 * Deliberately narrower than the admin's. A customer may cancel, take a
 * cancellation back and change tariff; pausing and moving a billing date are
 * conversations, not buttons.
 */

export type ClientSubscriptionState = {
    status: "idle" | "done" | "error";
    message?: string;
    preview?: { summary: string; label: string };
};

/** The Abo, if it really is this customer's. Null otherwise. */
async function own(subscriptionId: string) {
    const { customer } = await getCurrentCustomer();
    const loaded = await loadSubscription(subscriptionId, customer.id, false);

    return loaded ? { customer, loaded } : null;
}

export async function cancelOwn(
    _previous: ClientSubscriptionState,
    data: FormData,
): Promise<ClientSubscriptionState> {
    const subscriptionId = String(data.get("subscriptionId") ?? "");
    const mine = await own(subscriptionId);

    if (!mine) {
        return { status: "error", message: "Dieses Abo gibt es nicht." };
    }

    try {
        await cancelSubscription(db, {
            subscriptionId,
            // A customer always cancels to the end of the period they have
            // paid for. Ending today would forfeit days they already bought,
            // and nothing here refunds them.
            when: "period_end",
            reason: String(data.get("reason") ?? "") || null,
            actor: {
                type: "customer",
                id: mine.customer.id,
                label: mine.customer.name,
            },
        });
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof SubscriptionStateError
        ) {
            return { status: "error", message: error.message };
        }

        throw error;
    }

    revalidatePath("/client/subscriptions");
    revalidatePath(`/client/subscriptions/${subscriptionId}`);

    return {
        status: "done",
        message:
            "Gekündigt. Die Leistungen laufen bis zum Ende des bezahlten Zeitraums weiter.",
    };
}

export async function resumeOwn(
    _previous: ClientSubscriptionState,
    data: FormData,
): Promise<ClientSubscriptionState> {
    const subscriptionId = String(data.get("subscriptionId") ?? "");
    const mine = await own(subscriptionId);

    if (!mine) {
        return { status: "error", message: "Dieses Abo gibt es nicht." };
    }

    try {
        await resumeCancellation(db, {
            subscriptionId,
            actor: {
                type: "customer",
                id: mine.customer.id,
                label: mine.customer.name,
            },
        });
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof SubscriptionStateError
        ) {
            return { status: "error", message: error.message };
        }

        throw error;
    }

    revalidatePath("/client/subscriptions");
    revalidatePath(`/client/subscriptions/${subscriptionId}`);

    return { status: "done", message: "Die Kündigung ist zurückgenommen." };
}

/**
 * Tarifwechsel, with its price first.
 *
 * "Preis anzeigen" and "Wechseln" are the same form and the same action; the
 * only difference is the `intent`, and both end in `previewChange()`. What
 * the customer reads is what they are charged.
 */
export async function changeOwn(
    _previous: ClientSubscriptionState,
    data: FormData,
): Promise<ClientSubscriptionState> {
    const subscriptionId = String(data.get("subscriptionId") ?? "");
    const mine = await own(subscriptionId);

    if (!mine) {
        return { status: "error", message: "Dieses Abo gibt es nicht." };
    }

    const request = {
        subscriptionId,
        itemId: String(data.get("itemId") ?? ""),
        productId: String(data.get("productId") ?? "").trim() || null,
        quantity: null,
        options: null,
        effective:
            data.get("effective") === "period_end"
                ? ("period_end" as const)
                : ("immediately" as const),
    };

    try {
        const preview = await previewChange(db, request);

        if (data.get("intent") === "preview") {
            return {
                status: "idle",
                preview: {
                    summary: describePreview(preview),
                    label: preview.label,
                },
            };
        }

        const result = await applyChange(db, request, {
            type: "customer",
            id: mine.customer.id,
            label: mine.customer.name,
        });

        revalidatePath("/client/subscriptions");
        revalidatePath(`/client/subscriptions/${subscriptionId}`);
        revalidatePath("/client/invoices");

        return {
            status: "done",
            message: result.appliedNow
                ? result.invoiceNumber
                    ? `Gewechselt. Die Rechnung ${result.invoiceNumber} liegt unter „Rechnungen“.`
                    : result.creditedCents > 0
                      ? "Gewechselt. Die Differenz liegt als Guthaben auf deinem Konto."
                      : "Gewechselt."
                : "Der Wechsel greift zum Ende des laufenden Zeitraums.",
        };
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof SubscriptionStateError ||
            error instanceof CatalogError
        ) {
            return { status: "error", message: error.message };
        }

        throw error;
    }
}
