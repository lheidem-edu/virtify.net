import { notFound } from "next/navigation";
import { db } from "@/db";
import { ticketViewer } from "@/server/tickets/access";
import { readAttachment, safeFilename } from "@/server/tickets/attachments";
import { attachmentInScope } from "@/server/tickets/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One ticket attachment.
 *
 * The scope check is a join, not an afterthought: `attachmentInScope` walks
 * attachment → message → ticket → customer, so a customer asking for an id
 * that belongs to somebody else's ticket is refused by the `where` clause.
 * It also refuses anything hanging off an **internal note**, which is a
 * thing staff wrote in the knowledge that it stays inside.
 *
 * `Content-Disposition: attachment` and a narrow content type, deliberately:
 * these bytes arrived from outside and must not be rendered by this origin.
 */
export async function GET(
    _request: Request,
    context: { params: Promise<{ id: string }> },
) {
    const { id } = await context.params;
    const { scope } = await ticketViewer();

    if (!(await attachmentInScope(id, scope, db))) {
        notFound();
    }

    const found = await readAttachment(db, id);

    if (!found) {
        notFound();
    }

    const filename = safeFilename(found.row.filename).replace(/["\\]/g, "_");

    return new Response(new Uint8Array(found.bytes), {
        headers: {
            // Never the type the sender claimed: a text/html attachment
            // served inline would run as this origin's document.
            "content-type": "application/octet-stream",
            "content-length": String(found.bytes.byteLength),
            "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
                filename,
            )}`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
        },
    });
}
