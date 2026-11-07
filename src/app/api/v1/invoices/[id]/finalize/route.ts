import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { json, notFound, problem } from "@/server/api/respond";
import { serializeInvoice } from "@/server/billing/invoices/api";
import { storeFinalizedPdf } from "@/server/billing/invoices/pdf";
import {
    ANY_CUSTOMER,
    loadInvoice,
} from "@/server/billing/invoices/repository";
import {
    finalizeInvoice,
    InvoiceError,
} from "@/server/billing/invoices/service";

export const dynamic = "force-dynamic";

/**
 * Finalizing: the gapless number is assigned, the tax strategy in force at
 * this instant is applied and frozen, and the document becomes read-only.
 *
 * Staff only, and deliberately not idempotent in the "do it twice, get the
 * same answer" sense: a second call against an invoice that is no longer a
 * draft is refused with 409 rather than quietly succeeding, because the
 * caller's picture of the invoice is wrong and silence would keep it that way.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "billing.write");

    if (!auth.ok) {
        return auth.response;
    }

    if (scopedCustomerId(auth.context)) {
        return notFound();
    }

    const { id } = await params;

    try {
        await finalizeInvoice(db, id, {
            type: "api",
            id: auth.context.key.id,
            label: auth.context.key.prefix,
        });
    } catch (error) {
        if (error instanceof InvoiceError) {
            if (error.code === "not-found") {
                return notFound();
            }

            return problem(
                error.code === "not-draft" ? 409 : 422,
                error.code === "not-draft"
                    ? "Nicht mehr änderbar"
                    : "Rechnung unvollständig",
                error.message,
            );
        }

        throw error;
    }

    // Outside the transaction: neither a slow renderer nor a full disk may
    // roll back a number that has already been handed out.
    await storeFinalizedPdf(db, "invoice", id);

    const loaded = await loadInvoice(id, ANY_CUSTOMER, true, db);

    if (!loaded) {
        return notFound();
    }

    return json(
        serializeInvoice(loaded.invoice, loaded.items, loaded.creditNotes),
    );
}
