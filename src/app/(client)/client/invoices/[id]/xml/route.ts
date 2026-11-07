import { notFound } from "next/navigation";
import { db } from "@/db";
import { sellerOf } from "@/server/billing/invoices/pdf";
import { loadInvoice } from "@/server/billing/invoices/repository";
import { documentViewer } from "@/server/documents/access";
import { xmlBuyer } from "@/server/documents/repository";
import { renderXRechnung } from "@/server/documents/xrechnung";
import { loadSettings } from "@/server/settings";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { customerId, isAdmin } = await documentViewer("billing.read");
    const { id } = await params;

    const loaded = await loadInvoice(id, customerId, isAdmin, db);

    // XRechnung describes a finalized invoice; a draft has no number to carry.
    if (
        !loaded ||
        loaded.invoice.status === "draft" ||
        !loaded.invoice.number
    ) {
        notFound();
    }

    const { invoice, buyer, totals, taxNotes } = loaded;
    // Narrowed above; re-binding through the destructure loses it.
    const number = invoice.number as string;

    const settings = await loadSettings();

    const xml = renderXRechnung({
        seller: sellerOf(invoice, settings),
        siteName: settings.site.name,
        number,
        typeCode: "380",
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
        taxNotes,
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
