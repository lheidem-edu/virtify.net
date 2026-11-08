import { db } from "@/db";
import { invalid, json, problem } from "@/server/api/respond";
import {
    resumeBodySchema,
    serializeSubscription,
} from "@/server/subscriptions/api";
import { guardSubscriptionAction } from "@/server/subscriptions/guard";
import {
    ANY_CUSTOMER,
    loadSubscription,
} from "@/server/subscriptions/repository";
import {
    resumeCancellation,
    resumeSubscription,
    SubscriptionError,
} from "@/server/subscriptions/service";
import { SubscriptionStateError } from "@/server/subscriptions/state";

export const dynamic = "force-dynamic";

/**
 * Setzt ein Abo fort — entweder aus der Pause, oder indem eine Kündigung zum
 * Ende des Zeitraums zurückgenommen wird.
 *
 * `what` says which, and `auto` picks the one that applies: an Abo cannot be
 * both paused and running out its notice, so there is nothing to guess. They
 * are one endpoint because they are one sentence from the customer's side —
 * "mach weiter" — and two endpoints would make a client decide which verb
 * their own state is in.
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

    const parsed = resumeBodySchema.safeParse(guard.body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const loaded = await loadSubscription(id, ANY_CUSTOMER, true, db);

    if (!loaded) {
        return problem(
            500,
            "Abo nicht lesbar",
            "Das Abo konnte nicht gelesen werden.",
        );
    }

    const what =
        parsed.data.what !== "auto"
            ? parsed.data.what
            : loaded.subscription.status === "paused"
              ? "paused"
              : "cancellation";

    try {
        if (what === "paused") {
            await resumeSubscription(db, {
                subscriptionId: id,
                actor: guard.actor,
            });
        } else {
            await resumeCancellation(db, {
                subscriptionId: id,
                actor: guard.actor,
            });
        }
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof SubscriptionStateError
        ) {
            return problem(409, "Fortsetzen nicht möglich", error.message);
        }

        throw error;
    }

    const after = await loadSubscription(id, ANY_CUSTOMER, true, db);

    return after
        ? json(serializeSubscription(after))
        : problem(
              500,
              "Abo nicht lesbar",
              "Das Abo konnte nicht gelesen werden.",
          );
}
