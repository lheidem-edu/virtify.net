import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { invalid, json } from "@/server/api/respond";
import {
    serializeTransaction,
    transactionQuerySchema,
} from "@/server/payments/api";
import { listTransactionsPage } from "@/server/payments/repository";

export const dynamic = "force-dynamic";

/**
 * Every movement of money, seen through the key that asks.
 *
 * A customer key is pinned to its own account: `customer_id` is overwritten
 * rather than validated, so there is no query that would let it reach another
 * account's rows. A staff key sees everything `payments.read` covers.
 */
export async function GET(request: Request) {
    const auth = await authenticate(request, "payments.read");

    if (!auth.ok) {
        return auth.response;
    }

    const url = new URL(request.url);
    const parsed = transactionQuerySchema.safeParse(
        Object.fromEntries(url.searchParams),
    );

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const scoped = scopedCustomerId(auth.context);

    const page = await listTransactionsPage(db, {
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
        // The key's own account wins over anything the query string says.
        customerId: scoped ?? parsed.data.customer_id ?? null,
        invoiceId: parsed.data.invoice_id ?? null,
        provider: parsed.data.provider ?? null,
        status: parsed.data.status ?? null,
        kind: parsed.data.kind ?? null,
    });

    return json({
        data: page.data.map(serializeTransaction),
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    });
}
