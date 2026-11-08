import { db } from "@/db";
import { invalid, json, problem } from "@/server/api/respond";
import { CatalogError } from "@/server/catalog/repository";
import {
    changeBodySchema,
    serializePreview,
    serializeSubscription,
} from "@/server/subscriptions/api";
import { applyChange } from "@/server/subscriptions/changes";
import { guardSubscriptionAction } from "@/server/subscriptions/guard";
import {
    ANY_CUSTOMER,
    loadSubscription,
} from "@/server/subscriptions/repository";
import { SubscriptionError } from "@/server/subscriptions/service";
import { SubscriptionStateError } from "@/server/subscriptions/state";

export const dynamic = "force-dynamic";

/**
 * Wechselt den Tarif einer Position — anderes Produkt, andere Menge, andere
 * Optionen.
 *
 * The body is identical to `GET …/preview-change`, and so is the arithmetic:
 * both call `previewChange()`, and this one books what it returned. They
 * cannot disagree, which matters here more than anywhere else — the preview
 * is the number the customer agreed to and this is the number they are
 * charged.
 *
 * Immediately: the difference for the rest of the period is invoiced when it
 * is positive and credited to the account when it is negative. At the end of
 * the period: nothing moves today and the renewal is built from the new
 * configuration.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const guard = await guardSubscriptionAction(request, id);

    if (!guard.ok) {
        return guard.response;
    }

    const parsed = changeBodySchema.safeParse(guard.body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    let result: Awaited<ReturnType<typeof applyChange>>;

    try {
        result = await applyChange(
            db,
            {
                subscriptionId: id,
                itemId: parsed.data.item_id,
                productId: parsed.data.product_id ?? null,
                quantity: parsed.data.quantity ?? null,
                options:
                    parsed.data.options?.map((option) => ({
                        optionId: option.option_id,
                        valueId: option.value_id,
                        quantity: option.quantity,
                    })) ?? null,
                effective: parsed.data.effective,
            },
            guard.actor,
        );
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof SubscriptionStateError ||
            error instanceof CatalogError
        ) {
            return problem(409, "Tarifwechsel nicht möglich", error.message);
        }

        throw error;
    }

    const loaded = await loadSubscription(id, ANY_CUSTOMER, true, db);

    if (!loaded) {
        return problem(
            500,
            "Abo nicht lesbar",
            "Der Wechsel wurde gebucht, das Abo konnte aber nicht gelesen werden.",
        );
    }

    return json({
        subscription: serializeSubscription(loaded),
        preview: serializePreview(result.preview),
        change_id: result.changeId,
        invoice_id: result.invoiceId,
        invoice_number: result.invoiceNumber,
        credited_cents: result.creditedCents,
        applied_now: result.appliedNow,
    });
}
