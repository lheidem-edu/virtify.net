"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/db";
import { requirePermission } from "@/server/auth/staff-session";
import {
    cancelRenewalInvoice,
    waiveDunningFee,
} from "@/server/billing/reversals";
import { runBilling } from "@/server/billing/run";
import { CatalogError } from "@/server/catalog/repository";
import {
    applyChange,
    cancelPendingChange,
    previewChange,
} from "@/server/subscriptions/changes";
import {
    adjustSubscription,
    cancelSubscription,
    pauseSubscription,
    resumeCancellation,
    resumeSubscription,
    SubscriptionError,
} from "@/server/subscriptions/service";
import { SubscriptionStateError } from "@/server/subscriptions/state";

/**
 * The operator's buttons. Thin by design: every rule — what a cancellation
 * does to the services, what a plan change costs, what taking a renewal back
 * puts right — lives in `src/server/subscriptions` and
 * `src/server/billing`, which the tests drive directly.
 */

export type SubscriptionActionState = {
    status: "idle" | "done" | "error";
    message?: string;
};

async function staffActor() {
    const session = await requirePermission("subscriptions.write");

    await headers();

    return {
        type: "staff" as const,
        id: session.user.id,
        label: session.user.email,
    };
}

function refresh(subscriptionId: string) {
    revalidatePath("/admin/subscriptions");
    revalidatePath(`/admin/subscriptions/${subscriptionId}`);
    revalidatePath("/client/subscriptions");
}

/** Turns the three expected failures into a sentence, and nothing else. */
async function attempt(
    subscriptionId: string,
    done: string,
    work: () => Promise<unknown>,
): Promise<SubscriptionActionState> {
    try {
        await work();
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

    refresh(subscriptionId);

    return { status: "done", message: done };
}

export async function cancel(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const actor = await staffActor();
    const subscriptionId = String(data.get("subscriptionId") ?? "");
    const when = data.get("when") === "now" ? "now" : "period_end";

    return attempt(
        subscriptionId,
        when === "now"
            ? "Das Abo ist beendet."
            : "Das Abo endet zum Ende des Zeitraums.",
        () =>
            cancelSubscription(db, {
                subscriptionId,
                when,
                reason: String(data.get("reason") ?? "") || null,
                actor,
            }),
    );
}

export async function pause(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const actor = await staffActor();
    const subscriptionId = String(data.get("subscriptionId") ?? "");

    return attempt(subscriptionId, "Das Abo ist pausiert.", () =>
        pauseSubscription(db, {
            subscriptionId,
            reason: String(data.get("reason") ?? "") || null,
            actor,
        }),
    );
}

export async function resume(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const actor = await staffActor();
    const subscriptionId = String(data.get("subscriptionId") ?? "");
    const what = String(data.get("what") ?? "paused");

    return attempt(subscriptionId, "Das Abo läuft weiter.", () =>
        what === "cancellation"
            ? resumeCancellation(db, { subscriptionId, actor })
            : resumeSubscription(db, { subscriptionId, actor }),
    );
}

/**
 * Moves the billing date, the collection settings or a position's price by
 * hand. The figure the operator types is written to the Abo's snapshot,
 * which is what a price change on a running contract *is* — a change the
 * customer should see priced first goes through the Tarifwechsel below.
 */
export async function adjust(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const actor = await staffActor();
    const subscriptionId = String(data.get("subscriptionId") ?? "");
    const nextBilling = String(data.get("nextBillingAt") ?? "").trim();
    const items: { id: string; unitPriceCents: number }[] = [];

    for (const [key, value] of data.entries()) {
        if (!key.startsWith("price:")) {
            continue;
        }

        const cents = Math.round(Number(String(value).replace(",", ".")) * 100);

        if (!Number.isSafeInteger(cents) || cents < 0) {
            return {
                status: "error",
                message: "Ein Preis muss eine Zahl ab 0 sein.",
            };
        }

        items.push({ id: key.slice("price:".length), unitPriceCents: cents });
    }

    return attempt(subscriptionId, "Gespeichert.", () =>
        adjustSubscription(db, {
            subscriptionId,
            nextBillingAt: nextBilling ? new Date(nextBilling) : undefined,
            autoCharge: data.has("autoCharge")
                ? data.get("autoCharge") === "on"
                : undefined,
            items,
            actor,
        }),
    );
}

export type ChangeActionState = SubscriptionActionState & {
    /** What the change would cost, when the operator asked for a preview. */
    preview?: {
        label: string;
        summary: string;
        invoiceTodayCents: number;
        creditTodayCents: number;
        nextPeriodCents: number;
    };
};

/**
 * One action for both buttons: "Vorschau" stops after the arithmetic,
 * "Wechseln" books it. They call the same `previewChange()` underneath — the
 * preview an operator reads and the figure the customer is charged are one
 * number, which is the whole point of that function.
 */
export async function change(
    _previous: ChangeActionState,
    data: FormData,
): Promise<ChangeActionState> {
    const actor = await staffActor();
    const subscriptionId = String(data.get("subscriptionId") ?? "");
    const itemId = String(data.get("itemId") ?? "");
    const productId = String(data.get("productId") ?? "").trim() || null;
    const quantityRaw = String(data.get("quantity") ?? "").trim();
    const quantity = quantityRaw ? Number(quantityRaw) : null;
    const effective =
        data.get("effective") === "period_end" ? "period_end" : "immediately";
    const onlyPreview = data.get("intent") === "preview";

    const request = {
        subscriptionId,
        itemId,
        productId,
        quantity,
        options: null,
        effective,
    } as const;

    try {
        if (onlyPreview) {
            const { describePreview } = await import(
                "@/server/subscriptions/changes"
            );
            const preview = await previewChange(db, request);

            return {
                status: "idle",
                preview: {
                    label: preview.label,
                    summary: describePreview(preview),
                    invoiceTodayCents: preview.invoiceTodayCents,
                    creditTodayCents: preview.creditTodayCents,
                    nextPeriodCents: preview.nextPeriodCents,
                },
            };
        }

        const result = await applyChange(db, request, actor);

        refresh(subscriptionId);

        return {
            status: "done",
            message: result.appliedNow
                ? result.invoiceNumber
                    ? `Gewechselt. Rechnung ${result.invoiceNumber} wurde gestellt.`
                    : result.creditedCents > 0
                      ? "Gewechselt. Die Differenz ist dem Guthaben gutgeschrieben."
                      : "Gewechselt."
                : "Der Wechsel ist zum Ende des Zeitraums vorgemerkt.",
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

export async function withdrawChange(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const actor = await staffActor();
    const subscriptionId = String(data.get("subscriptionId") ?? "");

    return attempt(subscriptionId, "Der Wechsel ist zurückgenommen.", () =>
        cancelPendingChange(db, {
            changeId: String(data.get("changeId") ?? ""),
            actor,
        }),
    );
}

/**
 * Takes a renewal invoice back: a Rechnungskorrektur over the whole of it,
 * the coupon period given back, and the billing period rolled to where it
 * was — so the next run may raise a correct one.
 */
export async function revokeRenewal(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const session = await requirePermission("billing.write");
    const subscriptionId = String(data.get("subscriptionId") ?? "");

    await headers();

    return attempt(
        subscriptionId,
        "Die Verlängerung ist zurückgenommen und korrigiert.",
        () =>
            cancelRenewalInvoice(db, {
                invoiceId: String(data.get("invoiceId") ?? ""),
                reason: String(data.get("reason") ?? "") || null,
                actor: {
                    type: "staff",
                    id: session.user.id,
                    label: session.user.email,
                },
            }),
    );
}

/** Erlässt eine Mahngebühr — eine Korrektur über die Gebührenrechnung. */
export async function waiveFee(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const session = await requirePermission("billing.write");

    await headers();

    try {
        await waiveDunningFee(db, {
            dunningActionId: String(data.get("dunningActionId") ?? ""),
            reason: String(data.get("reason") ?? "") || null,
            actor: {
                type: "staff",
                id: session.user.id,
                label: session.user.email,
            },
        });
    } catch (error) {
        if (error instanceof SubscriptionError) {
            return { status: "error", message: error.message };
        }

        throw error;
    }

    revalidatePath("/admin/jobs");
    revalidatePath("/admin/invoices");

    return { status: "done", message: "Die Mahngebühr ist erlassen." };
}

/**
 * "Jetzt abrechnen" — the daily pass, run here and now.
 *
 * It bypasses the day marker on purpose: that marker is the cheap layer that
 * keeps a second cron pass off the database, and an operator asking for a
 * run is exactly the case it is allowed to be bypassed for. What stops a
 * customer being invoiced twice is the unique indexes underneath, not this
 * button's good behaviour.
 */
export async function runNow(
    _previous: SubscriptionActionState,
    data: FormData,
): Promise<SubscriptionActionState> {
    const session = await requirePermission("jobs.manage");

    await headers();

    const result = await runBilling(db, {
        force: true,
        forcedBy: session.user.email,
        customerId: String(data.get("customerId") ?? "") || null,
        actor: {
            type: "staff",
            id: session.user.id,
            label: session.user.email,
        },
    });

    revalidatePath("/admin/jobs");
    revalidatePath("/admin/subscriptions");
    revalidatePath("/admin/invoices");

    const report = result.report;

    return {
        status: report.failures.length > 0 ? "error" : "done",
        message:
            `${report.invoicesIssued} Rechnung(en) gestellt, ` +
            `${report.periodsAdvanced} Zeitraum/Zeiträume verlängert, ` +
            `${report.dunningActions} Mahnschritt(e), ` +
            `${report.failures.length} Fehler.`,
    };
}
