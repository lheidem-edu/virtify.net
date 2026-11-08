import "server-only";
import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { malformed, notFound } from "@/server/api/respond";
import type { Permission } from "@/server/auth/permissions";
import {
    ANY_CUSTOMER,
    loadSubscription,
} from "@/server/subscriptions/repository";

/**
 * What every action under `/api/v1/subscriptions/{id}` has to do before it
 * does anything: authenticate, read the body, and establish that this key
 * may see this Abo *at all*.
 *
 * It is one function rather than four copies because the last step is the
 * one that matters and the one that is easy to forget: a customer key that
 * named somebody else's subscription id must get 404 — not 403, which would
 * confirm the row exists, and certainly not a pause.
 */
export type Guarded =
    | {
          ok: true;
          body: unknown;
          customerId: string;
          actor: { type: "api"; id: string; label: string };
      }
    | { ok: false; response: Response };

export async function guardSubscriptionAction(
    request: Request,
    id: string,
    needed: Permission = "subscriptions.write",
): Promise<Guarded> {
    const auth = await authenticate(request, needed);

    if (!auth.ok) {
        return { ok: false, response: auth.response };
    }

    const own = scopedCustomerId(auth.context);
    const loaded = await loadSubscription(
        id,
        own ?? ANY_CUSTOMER,
        own === null,
        db,
    );

    if (!loaded) {
        return { ok: false, response: notFound() };
    }

    let body: unknown = {};

    if (request.method !== "GET") {
        const text = await request.text();

        if (text.trim() !== "") {
            try {
                body = JSON.parse(text);
            } catch {
                return { ok: false, response: malformed() };
            }
        }
    }

    return {
        ok: true,
        body,
        customerId: loaded.subscription.customerId,
        actor: {
            type: "api",
            id: auth.context.key.id,
            label: auth.context.key.prefix,
        },
    };
}
