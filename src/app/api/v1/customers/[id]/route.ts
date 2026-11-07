import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { invalid, json, malformed, notFound } from "@/server/api/respond";
import {
    fromWire,
    patchBodySchema,
    selfPatchBodySchema,
    serializeCustomer,
    serializeForCustomer,
} from "@/server/customers/api";
import { getCustomer, updateCustomer } from "@/server/customers/repository";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * A key that may not see this row is told the row is not there. Answering 403
 * would confirm that the id exists, which is the one thing a caller guessing
 * ids is trying to learn.
 */
function outOfScope(
    context: Parameters<typeof scopedCustomerId>[0],
    id: string,
) {
    const own = scopedCustomerId(context);

    return own !== null && own !== id;
}

export async function GET(request: Request, { params }: Params) {
    const auth = await authenticate(request, "customers.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;

    if (outOfScope(auth.context, id)) {
        return notFound();
    }

    const row = await getCustomer(db, id);

    if (!row) {
        return notFound();
    }

    return json(
        scopedCustomerId(auth.context)
            ? serializeForCustomer(row)
            : serializeCustomer(row),
    );
}

export async function PATCH(request: Request, { params }: Params) {
    const auth = await authenticate(request, "customers.write");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;

    if (outOfScope(auth.context, id)) {
        return notFound();
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    // A customer's own key gets the shorter schema: status, notes and
    // currency are the operator's to set, and a customer who could change
    // their status could lift their own suspension.
    const own = scopedCustomerId(auth.context);
    const schema = own ? selfPatchBodySchema : patchBodySchema;
    const parsed = schema.safeParse(fromWire(body));

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const row = await updateCustomer(db, id, parsed.data, {
        type: "api",
        id: auth.context.key.id,
        label: auth.context.key.prefix,
    });

    if (!row) {
        return notFound();
    }

    return json(own ? serializeForCustomer(row) : serializeCustomer(row));
}
