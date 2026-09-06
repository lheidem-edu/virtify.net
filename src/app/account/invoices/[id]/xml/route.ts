import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth-session";
import { loadInvoice } from "@/lib/documents/repository";
import { renderXRechnung } from "@/lib/documents/xrechnung";

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

    const xml = renderXRechnung({
        number,
        issuedAt: invoice.issuedAt ?? new Date(),
        dueAt: invoice.dueAt,
        buyerReference:
            invoice.buyerReference ?? buyer.buyerReference ?? buyer.id,
        servicePeriod: {
            start: invoice.servicePeriodStart,
            end: invoice.servicePeriodEnd,
        },
        note: invoice.note,
        buyer: {
            name: buyer.company || buyer.name,
            street: buyer.street,
            postalCode: buyer.postalCode,
            city: buyer.city,
            country: buyer.country,
            vatId: buyer.vatId,
            email: buyer.email,
        },
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
