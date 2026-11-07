import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { json, notFound } from "@/server/api/respond";
import { serializeOrder } from "@/server/orders/api";
import { ANY_CUSTOMER, loadOrder } from "@/server/orders/repository";

export const dynamic = "force-dynamic";

/**
 * One order with its positions, its subscriptions and the services it
 * created. A key that may not see the row is told 404, never 403 — 403 would
 * confirm that the id exists.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "orders.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;
    const own = scopedCustomerId(auth.context);
    const loaded = await loadOrder(id, own ?? ANY_CUSTOMER, own === null, db);

    if (!loaded) {
        return notFound();
    }

    return json(serializeOrder(loaded));
}
