import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { listInvoices } from "@/lib/documents/repository";
import type { INVOICE_STATUS_LABEL } from "@/lib/format";
import { paypalEnabled, stripeEnabled } from "@/lib/payments/config";
import InvoicesTable from "./invoices-table";

export default async function Page() {
    const session = await requireSession();

    // Which providers exist is a server-side question; the table only ever
    // sees the two booleans.
    const stripe = stripeEnabled();
    const paypal = paypalEnabled();

    const invoices = (await listInvoices(session.user.id, false))
        // Drafts are working state on our side and never shown to customers.
        .filter((entry) => entry.status !== "draft")
        .map((entry) => ({
            id: entry.id,
            number: entry.number,
            status: entry.status as keyof typeof INVOICE_STATUS_LABEL,
            issuedAt: entry.issuedAt,
            dueAt: entry.dueAt,
            paidAt: entry.paidAt,
            email: entry.email,
            amount: entry.amount,
            isCorrection: entry.cancelsInvoiceId !== null,
            // A correction reverses a demand for money; it is never one.
            canPay:
                entry.status === "issued" &&
                !entry.cancelsInvoiceId &&
                !entry.paidAt,
        }));

    return (
        <>
            <PageHeader
                title="Rechnungen"
                intro={
                    stripe || paypal
                        ? "Alle ausgestellten Rechnungen als PDF und als XRechnung. Offene Rechnungen kannst du hier direkt bezahlen."
                        : "Alle ausgestellten Rechnungen als PDF und als XRechnung."
                }
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <InvoicesTable
                    rows={invoices}
                    stripe={stripe}
                    paypal={paypal}
                />
            </div>
        </>
    );
}
