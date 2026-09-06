import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth-session";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import { formatRecipient, loadOffer } from "@/lib/documents/repository";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await requireSession();
    const { id } = await params;
    const isAdmin = session.user.role === "admin";

    const loaded = await loadOffer(id, session.user.id, isAdmin);

    if (!loaded || (!isAdmin && loaded.offer.status === "draft")) {
        notFound();
    }

    const { offer, buyer, totals } = loaded;

    const pdf = await renderDocumentPdf({
        kind: "offer",
        number: offer.number,
        title: offer.title,
        recipient: offer.recipient ?? formatRecipient(buyer),
        issuedAt: offer.sentAt ?? offer.createdAt,
        validUntil: offer.validUntil,
        introText: offer.introText,
        note: offer.note,
        totals,
    });

    return new Response(new Uint8Array(pdf), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${offer.number.replace(/[^\w.-]/g, "-")}.pdf"`,
            "Cache-Control": "private, no-store",
        },
    });
}
