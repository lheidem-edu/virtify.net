import { notFound } from "next/navigation";
import { db } from "@/db";
import { sellerOf } from "@/server/billing/invoices/pdf";
import { loadCreditNote } from "@/server/billing/invoices/repository";
import { documentViewer } from "@/server/documents/access";
import { loadBuyer, xmlBuyer } from "@/server/documents/repository";
import { renderXRechnung } from "@/server/documents/xrechnung";
import { loadSettings } from "@/server/settings";

/** UNTDID 1001 type 381, positive amounts, referencing the invoice it credits. */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { customerId, isAdmin } = await documentViewer("billing.read");
    const { id } = await params;

    const loaded = await loadCreditNote(id, customerId, isAdmin, db);

    if (!loaded) {
        notFound();
    }

    const { creditNote, totals, invoice } = loaded;
    const settings = await loadSettings();
    const buyer = await loadBuyer(creditNote.customerId, db);

    const xml = renderXRechnung({
        seller: sellerOf(creditNote, settings),
        siteName: settings.site.name,
        number: creditNote.number,
        typeCode: "381",
        issuedAt: creditNote.issuedAt,
        dueAt: null,
        buyerReference:
            creditNote.buyerReference ??
            buyer.buyerReference ??
            String(buyer.customerNumber ?? buyer.id),
        servicePeriod: {
            start: creditNote.servicePeriodStart,
            end: creditNote.servicePeriodEnd,
        },
        note: creditNote.note,
        taxNotes: creditNote.taxNote ? [creditNote.taxNote] : [],
        precedingNumber: invoice?.number ?? null,
        precedingIssuedAt: invoice?.issuedAt ?? null,
        buyer: xmlBuyer(creditNote, buyer),
        totals,
    });

    return new Response(xml, {
        headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Content-Disposition": `attachment; filename="${creditNote.number.replace(/[^\w.-]/g, "-")}.xml"`,
            "Cache-Control": "private, no-store",
        },
    });
}
