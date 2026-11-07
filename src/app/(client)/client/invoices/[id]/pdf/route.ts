import { notFound } from "next/navigation";
import { db } from "@/db";
import { invoicePdf } from "@/server/billing/invoices/pdf";
import { documentViewer } from "@/server/documents/access";

/**
 * One URL for both sides: a customer opens their own invoice from the
 * Kundenbereich, an employee opens the same document from Verwaltung.
 * `documentViewer()` says which of the two is asking, and the loader behind
 * `invoicePdf` constrains the query accordingly — a foreign id is a 404.
 *
 * A finalized invoice is served from the document store, byte for byte as it
 * was rendered when it was issued.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const viewer = await documentViewer("billing.read");
    const { id } = await params;

    const result = await invoicePdf(db, id, viewer);

    if (!result) {
        notFound();
    }

    return new Response(new Uint8Array(result.bytes), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${result.filename}"`,
            // Invoices are personal documents; shared caches must not hold them.
            "Cache-Control": "private, no-store",
        },
    });
}
