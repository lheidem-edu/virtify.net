import { db } from "@/db";
import { invalid, json, problem } from "@/server/api/respond";
import {
    cancelBodySchema,
    serializeSubscription,
} from "@/server/subscriptions/api";
import { guardSubscriptionAction } from "@/server/subscriptions/guard";
import {
    ANY_CUSTOMER,
    loadSubscription,
} from "@/server/subscriptions/repository";
import {
    cancelSubscription,
    SubscriptionError,
} from "@/server/subscriptions/service";
import { SubscriptionStateError } from "@/server/subscriptions/state";

export const dynamic = "force-dynamic";

/**
 * Kündigt ein Abo — zum Ende des Zeitraums (die Voreinstellung) oder sofort.
 *
 * Neither refunds anything. § 8 of the terms leaves that to the operator,
 * and a cancellation that quietly issued a Rechnungskorrektur would be the
 * panel deciding something nobody asked it to.
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

    const parsed = cancelBodySchema.safeParse(guard.body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    try {
        await cancelSubscription(db, {
            subscriptionId: id,
            when: parsed.data.when,
            reason: parsed.data.reason ?? null,
            actor: guard.actor,
        });
    } catch (error) {
        if (
            error instanceof SubscriptionError ||
            error instanceof SubscriptionStateError
        ) {
            return problem(409, "Kündigung nicht möglich", error.message);
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
