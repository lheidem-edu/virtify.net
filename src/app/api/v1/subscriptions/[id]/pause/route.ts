import { db } from "@/db";
import { invalid, json, problem } from "@/server/api/respond";
import {
    pauseBodySchema,
    serializeSubscription,
} from "@/server/subscriptions/api";
import { guardSubscriptionAction } from "@/server/subscriptions/guard";
import {
    ANY_CUSTOMER,
    loadSubscription,
} from "@/server/subscriptions/repository";
import {
    pauseSubscription,
    SubscriptionError,
} from "@/server/subscriptions/service";
import { SubscriptionStateError } from "@/server/subscriptions/state";

export const dynamic = "force-dynamic";

/**
 * Pausiert ein Abo: keine Rechnungen, Leistungen gesperrt.
 *
 * The clock stops. `POST …/resume` starts it again and moves the end of the
 * period forward by exactly the span it stood still, so the customer neither
 * loses the days they could not use nor gains any.
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

    const parsed = pauseBodySchema.safeParse(guard.body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    try {
        await pauseSubscription(db, {
            subscriptionId: id,
            reason: parsed.data.reason ?? null,
            actor: guard.actor,
        });
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof SubscriptionStateError
        ) {
            return problem(409, "Pausieren nicht möglich", error.message);
        }

        throw error;
    }

    const loaded = await loadSubscription(id, ANY_CUSTOMER, true, db);

    return loaded
        ? json(serializeSubscription(loaded))
        : problem(
              500,
              "Abo nicht lesbar",
              "Das Abo konnte nicht gelesen werden.",
          );
}
