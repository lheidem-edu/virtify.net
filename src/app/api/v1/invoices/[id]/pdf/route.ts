import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { notFound } from "@/server/api/respond";
import { invoicePdf } from "@/server/billing/invoices/pdf";
import { ANY_CUSTOMER } from "@/server/billing/invoices/repository";

export const dynamic = "force-dynamic";

/**
 * The rendered document itself. A finalized invoice comes from the document
 * store, byte for byte as it was written when the invoice was issued.
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

    const result = await invoicePdf(db, id, {
        customerId: own ?? ANY_CUSTOMER,
        isAdmin: own === null,
    });

    if (!result) {
        return notFound();
    }

    return new Response(new Uint8Array(result.bytes), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${result.filename}"`,
            // Invoices are personal documents; shared caches must not hold them.
            "Cache-Control": "private, no-store",
        },
    });
}
