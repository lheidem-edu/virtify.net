import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { forbidden, invalid, json, malformed } from "@/server/api/respond";
import {
    createBodySchema,
    fromWire,
    listQuerySchema,
    serializeCustomer,
    serializeForCustomer,
} from "@/server/customers/api";
import {
    createCustomer,
    getCustomer,
    listCustomers,
} from "@/server/customers/repository";

export const dynamic = "force-dynamic";

/**
 * The list is scoped by the key, not by what the request asks for: a
 * customer's key is answered with its own account and nothing else, so there
 * is no parameter to tamper with.
 */
export async function GET(request: Request) {
    const auth = await authenticate(request, "customers.read");

    if (!auth.ok) {
        return auth.response;
    }

    const query = listQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
    );

    if (!query.success) {
        return invalid(query.error);
    }

    const own = scopedCustomerId(auth.context);

    if (own) {
        const row = await getCustomer(db, own);

        return json({
            data: row ? [serializeForCustomer(row)] : [],
            next_cursor: null,
            has_more: false,
        });
    }

    const page = await listCustomers(db, {
        cursor: query.data.cursor,
        limit: query.data.limit,
        query: query.data.q,
        status: query.data.status,
    });

    return json({
        data: page.data.map(serializeCustomer),
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    });
}

export async function POST(request: Request) {
    const auth = await authenticate(request, "customers.write");

    if (!auth.ok) {
        return auth.response;
    }

    if (scopedCustomerId(auth.context)) {
        return forbidden(
            "Ein Kundenschlüssel kann keine weiteren Kundenkonten anlegen.",
        );
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    const parsed = createBodySchema.safeParse(fromWire(body));

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const row = await createCustomer(db, parsed.data, {
        type: "api",
        id: auth.context.key.id,
        label: auth.context.key.prefix,
    });

    return json(serializeCustomer(row), 201);
}
