import { db } from "@/db";
import { invalid, json, problem } from "@/server/api/respond";
import { CatalogError } from "@/server/catalog/repository";
import {
    optionsFromQuery,
    previewQuerySchema,
    serializePreview,
} from "@/server/subscriptions/api";
import { describePreview, previewChange } from "@/server/subscriptions/changes";
import { guardSubscriptionAction } from "@/server/subscriptions/guard";
import { SubscriptionError } from "@/server/subscriptions/service";

export const dynamic = "force-dynamic";

/**
 * Was ein Tarifwechsel kosten würde — auf den Cent, ohne etwas zu ändern.
 *
 * It calls `previewChange()`, which is the **same** function
 * `POST …/change` books from. An endpoint that computed its own number here
 * would be the defect this project already shipped once — a checkout that
 * showed 29,99 € and charged 25,99 € — with the customer's agreement
 * attached to it.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const guard = await guardSubscriptionAction(
        request,
        id,
        "subscriptions.read",
    );

    if (!guard.ok) {
        return guard.response;
    }

    const url = new URL(request.url);
    const parsed = previewQuerySchema.safeParse({
        item_id: url.searchParams.get("item_id") ?? undefined,
        product_id: url.searchParams.get("product_id") ?? undefined,
        quantity: url.searchParams.get("quantity") ?? undefined,
        option: url.searchParams.getAll("option"),
        effective: url.searchParams.get("effective") ?? undefined,
    });

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    try {
        const preview = await previewChange(db, {
            subscriptionId: id,
            itemId: parsed.data.item_id,
            productId: parsed.data.product_id ?? null,
            quantity: parsed.data.quantity ?? null,
            options: optionsFromQuery(parsed.data.option),
            effective: parsed.data.effective,
        });

        return json({
            ...serializePreview(preview),
            summary: describePreview(preview),
        });
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof CatalogError
        ) {
            return problem(409, "Tarifwechsel nicht möglich", error.message);
        }

        if (error instanceof Error && error.message.includes("optionId")) {
            return problem(422, "Eingabe ungültig", error.message);
        }

        throw error;
    }
}
