import { notFound } from "next/navigation";
import { db } from "@/db";
import { creditNotePdf } from "@/server/billing/invoices/pdf";
import { documentViewer } from "@/server/documents/access";

/** The Rechnungskorrektur as a PDF, for the customer and for the operator. */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const viewer = await documentViewer("billing.read");
    const { id } = await params;

    const result = await creditNotePdf(db, id, viewer);

    if (!result) {
        notFound();
    }

    return new Response(new Uint8Array(result.bytes), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${result.filename}"`,
            "Cache-Control": "private, no-store",
        },
    });
}
