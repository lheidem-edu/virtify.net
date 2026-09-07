import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth-session";
import { loadInvoice, xmlBuyer } from "@/lib/documents/repository";
import { renderXRechnung } from "@/lib/documents/xrechnung";
import { loadSettings } from "@/lib/settings";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await requireSession();
    const { id } = await params;
    const isAdmin = session.user.role === "admin";

    const loaded = await loadInvoice(id, session.user.id, isAdmin);

    // XRechnung describes an issued invoice; a draft has no number to carry.
    if (
        !loaded ||
        loaded.invoice.status === "draft" ||
        !loaded.invoice.number
    ) {
        notFound();
    }

    const { invoice, buyer, totals } = loaded;
    // Narrowed above; re-binding through the destructure loses it.
    const number = invoice.number as string;

    const { operator, site } = await loadSettings();

    const xml = renderXRechnung({
        seller: operator,
        siteName: site.name,
        number,
        // A correction carries negative amounts, which a validator rejects
        // under 380; 384 is the corrected-invoice code it belongs to.
        typeCode: invoice.cancelsInvoiceId ? "384" : "380",
        issuedAt: invoice.issuedAt ?? new Date(),
        dueAt: invoice.dueAt,
        buyerReference:
            invoice.buyerReference ??
            buyer.buyerReference ??
            String(buyer.customerNumber ?? buyer.id),
        servicePeriod: {
            start: invoice.servicePeriodStart,
            end: invoice.servicePeriodEnd,
        },
        note: invoice.note,
        buyer: xmlBuyer(invoice, buyer),
        totals,
    });

    return new Response(xml, {
        headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Content-Disposition": `attachment; filename="${number.replace(/[^\w.-]/g, "-")}.xml"`,
            "Cache-Control": "private, no-store",
        },
    });
}
