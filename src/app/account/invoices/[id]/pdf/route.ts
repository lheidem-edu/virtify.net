import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth-session";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { formatRecipient, loadInvoice } from "@/lib/documents/repository";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await requireSession();
    const { id } = await params;
    const isAdmin = session.user.role === "admin";

    const loaded = await loadInvoice(id, session.user.id, isAdmin);

    // A draft has no number yet and is not a document the customer may see.
    if (!loaded || (!isAdmin && loaded.invoice.status === "draft")) {
        notFound();
    }

    const { invoice, buyer, totals } = loaded;

    const pdf = await renderDocumentPdf({
        kind: "invoice",
        number: invoice.number ?? "ENTWURF",
        subject: "Ihre Rechnung",
        customerNumber: buyer.customerNumber,
        recipient: invoice.recipient ?? formatRecipient(buyer),
        issuedAt: invoice.issuedAt ?? new Date(),
        dueAt: invoice.dueAt,
        servicePeriod: {
            start: invoice.servicePeriodStart,
            end: invoice.servicePeriodEnd,
        },
        introText: invoice.introText,
        note: invoice.note,
        totals,
        details: loaded.items.map((item) => item.detail),
    });

    return new Response(new Uint8Array(pdf), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${(invoice.number ?? id).replace(/[^\w.-]/g, "-")}.pdf"`,
            // Invoices are personal documents; shared caches must not hold them.
            "Cache-Control": "private, no-store",
        },
    });
}
