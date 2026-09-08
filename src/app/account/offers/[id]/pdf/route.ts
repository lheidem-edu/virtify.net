import { notFound } from "next/navigation";
import { documentViewer } from "@/lib/document-access";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { formatRecipient, loadOffer } from "@/lib/documents/repository";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { userId, isAdmin } = await documentViewer();
    const { id } = await params;

    const loaded = await loadOffer(id, userId, isAdmin);

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
        details: loaded.items.map((item) => item.detail),
    });

    return new Response(new Uint8Array(pdf), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${offer.number.replace(/[^\w.-]/g, "-")}.pdf"`,
            "Cache-Control": "private, no-store",
        },
    });
}
