import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { json, notFound } from "@/server/api/respond";
import { serializeSubscription } from "@/server/subscriptions/api";
import {
    ANY_CUSTOMER,
    loadSubscription,
} from "@/server/subscriptions/repository";

export const dynamic = "force-dynamic";

/**
 * One Abo with its positions, the services under them, every invoice ever
 * raised against it and its own timeline. A key that may not see the row is
 * told 404, never 403 — 403 would confirm the id exists.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "subscriptions.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;
    const own = scopedCustomerId(auth.context);
    const loaded = await loadSubscription(
        id,
        own ?? ANY_CUSTOMER,
        own === null,
        db,
    );

    if (!loaded) {
        return notFound();
    }

    return json(serializeSubscription(loaded));
}
