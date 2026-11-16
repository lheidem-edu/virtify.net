import { db } from "@/db";
import { audit } from "@/server/audit";
import { requestOrigin } from "@/server/audit/request";
import { getCurrentCustomer } from "@/server/customers/current";
import { exportCustomerData } from "@/server/customers/gdpr";

/**
 * Art. 15 / Art. 20 DSGVO: the whole account, as a ZIP.
 *
 * ## Five, in order
 *
 *  1. **No id in the URL.** The route takes none and cannot be given one:
 *     whose data comes back is decided by `getCurrentCustomer()`, which
 *     resolves the session against the database on every request. There is no
 *     parameter to tamper with, which is a stronger property than checking
 *     one (rule 5).
 *  2. **Audited.** This is a bulk read of everything one person has, which is
 *     exactly the shape of a leak, so every download leaves an entry naming
 *     the contact who asked and the address they asked from.
 *  3. **Never cached.** `no-store` and a `Content-Disposition` attachment:
 *     the archive holds somebody's invoices, and a proxy or a browser cache
 *     holding it is a copy nobody asked for.
 *  4. **No `Content-Length` games.** The body is one buffer; it is built,
 *     measured and sent, and the handler would rather spend the memory than
 *     hand back a truncated archive.
 *  5. **GET, deliberately.** A download is a read. It changes nothing except
 *     the audit log, and a POST would mean a form, a CSRF token and a
 *     round-trip for a button that exists to hand somebody a file.
 */
export async function GET(): Promise<Response> {
    const { customer, user } = await getCurrentCustomer();

    const result = await exportCustomerData(db, customer.id);
    const origin = await requestOrigin();

    await audit(db, {
        actor: { type: "customer", id: user.id, label: user.email },
        action: "customer.export",
        entityType: "customer",
        entityId: customer.id,
        after: {
            filename: result.filename,
            bytes: result.bytes.length,
            documents: result.summary.documents,
            missingDocuments: result.summary.missingDocuments,
            tables: result.summary.tables,
        },
        ip: origin.ip,
        userAgent: origin.userAgent,
    });

    return new Response(new Uint8Array(result.bytes), {
        headers: {
            "content-type": "application/zip",
            "content-length": String(result.bytes.length),
            // The filename carries the customer number and the date, so two
            // exports a month apart do not overwrite each other in a
            // downloads folder.
            "content-disposition": `attachment; filename="${result.filename}"`,
            "cache-control": "no-store, max-age=0",
        },
    });
}
