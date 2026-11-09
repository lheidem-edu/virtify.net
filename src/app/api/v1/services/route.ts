import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { invalid, json } from "@/server/api/respond";
import {
    serializeServiceRow,
    serviceListQuerySchema,
} from "@/server/provisioning/api";
import { ANY_CUSTOMER, listServices } from "@/server/provisioning/repository";

export const dynamic = "force-dynamic";

/**
 * Die Leistungen, seitenweise.
 *
 * A customer key sees its own and nothing else: the scope comes from the key
 * (`scopedCustomerId`), never from a parameter, so there is no `customer_id`
 * on this endpoint to honour or overwrite — staff keys see everything and
 * filter by status.
 *
 * Terminated services are hidden unless asked for. They are history: a list
 * that showed every machine a customer has ever had would bury the three
 * they are running.
 */
export async function GET(request: Request) {
    const auth = await authenticate(request, "services.read");

    if (!auth.ok) {
        return auth.response;
    }

    const url = new URL(request.url);
    const parsed = serviceListQuerySchema.safeParse(
        Object.fromEntries(url.searchParams),
    );

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const own = scopedCustomerId(auth.context);

    const rows = await listServices(db, own ?? ANY_CUSTOMER, {
        status: parsed.data.status ? [parsed.data.status] : undefined,
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
        includeTerminated: parsed.data.include_terminated,
    });

    const last = rows[rows.length - 1];

    return json({
        data: rows.map(serializeServiceRow),
        next_cursor:
            rows.length === parsed.data.limit ? (last?.id ?? null) : null,
        has_more: rows.length === parsed.data.limit,
    });
}
