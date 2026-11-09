import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { json, notFound } from "@/server/api/respond";
import { serializeService } from "@/server/provisioning/api";
import { ANY_CUSTOMER, loadService } from "@/server/provisioning/repository";

export const dynamic = "force-dynamic";

/**
 * Eine Leistung.
 *
 * A key that may not see this row gets **404, not 403** (rule 5): a 403
 * would confirm the id exists, which for a sequential-looking list of
 * machines is the one thing worth not confirming.
 *
 * A staff key additionally sees which cluster the machine is on, the
 * provider's own id for it and the task log. A customer key sees its own
 * machine and what it may ask of it.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "services.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;
    const own = scopedCustomerId(auth.context);
    const loaded = await loadService(db, id, own ?? ANY_CUSTOMER);

    if (!loaded) {
        return notFound();
    }

    return json(serializeService(loaded, { staff: own === null }));
}
