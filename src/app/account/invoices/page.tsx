import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { listInvoices } from "@/lib/documents/repository";
import type { INVOICE_STATUS_LABEL } from "@/lib/format";
import InvoicesTable from "./invoices-table";

export default async function Page() {
    const session = await requireSession();

    const invoices = (await listInvoices(session.user.id, false))
        // Drafts are working state on our side and never shown to customers.
        .filter((entry) => entry.status !== "draft")
        .map((entry) => ({
            id: entry.id,
            number: entry.number,
            status: entry.status as keyof typeof INVOICE_STATUS_LABEL,
            issuedAt: entry.issuedAt,
            dueAt: entry.dueAt,
            email: entry.email,
            amount: entry.amount,
            isStorno: entry.cancelsInvoiceId !== null,
        }));

    return (
        <>
            <PageHeader
                title="Rechnungen"
                intro="Alle ausgestellten Rechnungen als PDF und als XRechnung."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <InvoicesTable rows={invoices} />
            </div>
        </>
    );
}
