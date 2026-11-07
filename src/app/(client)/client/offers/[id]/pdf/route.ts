import { notFound } from "next/navigation";
import { documentViewer } from "@/server/documents/access";
import { renderDocumentPdf, sellerFromSettings } from "@/server/documents/pdf";
import { formatRecipient, loadOffer } from "@/server/documents/repository";
import { loadSettings } from "@/server/settings";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { customerId, isAdmin } = await documentViewer("offers.read");
    const { id } = await params;

    const loaded = await loadOffer(id, customerId, isAdmin);

    if (!loaded || (!isAdmin && loaded.offer.status === "draft")) {
        notFound();
    }

    const { offer, buyer, totals } = loaded;

    const pdf = await renderDocumentPdf({
        kind: "offer",
        number: offer.number,
        title: offer.title,
        customerNumber: buyer.customerNumber,
        recipient: offer.recipient ?? formatRecipient(buyer),
        issuedAt: offer.sentAt ?? offer.createdAt,
        validUntil: offer.validUntil,
        introText: offer.introText,
        note: offer.note,
        totals,
        seller: sellerFromSettings(await loadSettings()),
        showTax:
            totals.taxCents !== 0 ||
            totals.groups.some((group) => group.rateBp > 0),
        taxNotes: loaded.taxNotes,
    });

    return new Response(new Uint8Array(pdf), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${offer.number.replace(/[^\w.-]/g, "-")}.pdf"`,
            "Cache-Control": "private, no-store",
        },
    });
}
