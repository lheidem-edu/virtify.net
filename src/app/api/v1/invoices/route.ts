import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import {
    forbidden,
    invalid,
    json,
    malformed,
    problem,
} from "@/server/api/respond";
import {
    createBodySchema,
    fromWire,
    listQuerySchema,
    serializeInvoice,
    serializeInvoiceSummary,
} from "@/server/billing/invoices/api";
import { listInvoicesPage } from "@/server/billing/invoices/repository";
import {
    createInvoiceDraft,
    InvoiceError,
} from "@/server/billing/invoices/service";

export const dynamic = "force-dynamic";

/**
 * The list is scoped by the key, not by what the request asks for: a
 * customer's key is answered with that customer's invoices and nothing else,
 * and `customer_id` is ignored rather than honoured for one.
 */
export async function GET(request: Request) {
    const auth = await authenticate(request, "billing.read");

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

    // A draft has no number and no legal existence; it is working state on
    // our side, so a customer's key never sees one — and asking for drafts
    // with one simply returns nothing rather than an error that confirms
    // they exist.
    const page = await listInvoicesPage(db, {
        customerId: own ?? query.data.customer_id ?? null,
        status: own && query.data.status === "draft" ? null : query.data.status,
        excludeDrafts: Boolean(own),
        cursor: query.data.cursor,
        limit: query.data.limit,
    });

    return json({
        data: page.data.map(serializeInvoiceSummary),
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    });
}

/**
 * Creates a draft. Staff only: an invoice is a demand for money, and a
 * customer key that could write one would be able to invoice itself.
 */
export async function POST(request: Request) {
    const auth = await authenticate(request, "billing.write");

    if (!auth.ok) {
        return auth.response;
    }

    if (scopedCustomerId(auth.context)) {
        return forbidden("Ein Kundenschlüssel kann keine Rechnungen anlegen.");
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    const parsed = createBodySchema.safeParse(body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    try {
        const row = await createInvoiceDraft(db, fromWire(parsed.data), {
            type: "api",
            id: auth.context.key.id,
            label: auth.context.key.prefix,
        });

        return json(serializeInvoice(row, []), 201);
    } catch (error) {
        if (error instanceof InvoiceError) {
            return problem(422, "Rechnung ungültig", error.message);
        }

        throw error;
    }
}
