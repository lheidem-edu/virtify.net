import { notFound } from "next/navigation";
import { db } from "@/db";
import { type Actor, audit } from "@/server/audit";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import { exportCustomerData } from "@/server/customers/gdpr";
import { getCustomer } from "@/server/customers/repository";

/**
 * The same archive the customer can download, for the operator who was asked
 * for it in writing.
 *
 * It takes an id, which the portal's own export deliberately does not — so
 * the guard has to do the work the absence of a parameter does there:
 * `dsgvo.export`, checked server-side against the database on every request,
 * and a **404 for an account that does not exist**, never a 403, because a 403
 * confirms the id (rule 5).
 *
 * Audited under the employee's name. An export is a bulk read of one person's
 * whole record and the log is the only thing that can later say who took it.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
    const session = await requirePermission("dsgvo.export");
    const { id } = await params;

    const customer = await getCustomer(db, id);

    if (!customer) {
        notFound();
    }

    const result = await exportCustomerData(db, customer.id);
    const origin = await requestOrigin();

    await audit(db, {
        actor: {
            type: "staff",
            id: session.user.id,
            label: session.user.email,
        } satisfies Actor,
        action: "customer.export",
        entityType: "customer",
        entityId: customer.id,
        after: {
            filename: result.filename,
            bytes: result.bytes.length,
            documents: result.summary.documents,
            missingDocuments: result.summary.missingDocuments,
        },
        ip: origin.ip,
        userAgent: origin.userAgent,
    });

    return new Response(new Uint8Array(result.bytes), {
        headers: {
            "content-type": "application/zip",
            "content-length": String(result.bytes.length),
            "content-disposition": `attachment; filename="${result.filename}"`,
            "cache-control": "no-store, max-age=0",
        },
    });
}
