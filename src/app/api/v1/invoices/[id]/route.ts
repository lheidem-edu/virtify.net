import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { json, notFound } from "@/server/api/respond";
import { serializeInvoice } from "@/server/billing/invoices/api";
import {
    ANY_CUSTOMER,
    loadInvoice,
} from "@/server/billing/invoices/repository";

export const dynamic = "force-dynamic";

/**
 * One invoice with its positions. A key that may not see the row is told 404,
 * never 403 — 403 would confirm that the id exists.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "billing.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;
    const own = scopedCustomerId(auth.context);

    const loaded = await loadInvoice(id, own ?? ANY_CUSTOMER, own === null, db);

    // A draft is working state on our side and has no number; for a customer
    // key it does not exist.
    if (!loaded || (own && loaded.invoice.status === "draft")) {
        return notFound();
    }

    return json(
        serializeInvoice(loaded.invoice, loaded.items, loaded.creditNotes),
    );
}
