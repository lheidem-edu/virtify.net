import { asc } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { db, schema } from "@/lib/db";
import { listInvoices } from "@/lib/documents/repository";
import type { INVOICE_STATUS_LABEL } from "@/lib/format";
import AdminInvoicesTable from "./admin-invoices-table";
import InvoiceForm from "./invoice-form";

export default async function Page() {
    const session = await requireAdmin();

    const accounts = await db
        .select({
            id: schema.user.id,
            name: schema.user.name,
            email: schema.user.email,
        })
        .from(schema.user)
        .orderBy(asc(schema.user.email));

    const invoices = await listInvoices(session.user.id, true);

    return (
        <>
            <PageHeader
                title="Rechnungen"
                intro="Entwürfe anlegen und ausstellen. Beim Ausstellen wird die Nummer vergeben, das Dokument eingefroren und per E-Mail versendet."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Neue Rechnung
                </h2>
                <InvoiceForm accounts={accounts} />
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Alle Rechnungen
                </h2>
                <AdminInvoicesTable
                    rows={invoices.map((entry) => ({
                        id: entry.id,
                        number: entry.number,
                        status: entry.status as keyof typeof INVOICE_STATUS_LABEL,
                        issuedAt: entry.issuedAt,
                        dueAt: entry.dueAt,
                        email: entry.email,
                        amount: entry.amount,
                    }))}
                />
            </div>
        </>
    );
}
