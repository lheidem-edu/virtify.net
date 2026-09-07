import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { billingPeriod } from "@/lib/documents/contract-term";
import { dateInputValue } from "@/lib/documents/line-items";
import {
    listContracts,
    listCustomerAccounts,
    listInvoices,
    loadContract,
} from "@/lib/documents/repository";
import { DEFAULT_UNIT_CODE } from "@/lib/documents/totals";
import type { INVOICE_STATUS_LABEL } from "@/lib/format";
import AdminInvoicesTable from "./admin-invoices-table";
import InvoiceForm, { type InvoicePrefill } from "./invoice-form";

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{ contract?: string }>;
}) {
    const session = await requireAdmin();
    const { contract: contractId } = await searchParams;

    const accounts = await listCustomerAccounts();

    const [invoices, contracts] = await Promise.all([
        listInvoices(session.user.id, true),
        listContracts(session.user.id, true),
    ]);

    // Coming from a contract, the monthly invoice is entirely predictable:
    // one line at the agreed price for the month that is being billed.
    const loaded = contractId
        ? await loadContract(contractId, session.user.id, true)
        : null;
    const period = billingPeriod(new Date());
    const prefill: InvoicePrefill | undefined = loaded
        ? {
              userId: loaded.contract.userId,
              contractId: loaded.contract.id,
              items: [
                  {
                      description: loaded.contract.title,
                      detail: null,
                      quantity: 1,
                      unitCode: DEFAULT_UNIT_CODE,
                      unitPriceCents: loaded.contract.monthlyPriceCents,
                  },
              ],
              servicePeriodStart: dateInputValue(period.start),
              servicePeriodEnd: dateInputValue(period.end),
          }
        : undefined;

    return (
        <>
            <PageHeader
                title="Rechnungen"
                intro="Entwürfe anlegen und ausstellen. Beim Ausstellen wird die Nummer vergeben, das Dokument eingefroren und per E-Mail versendet."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    {loaded
                        ? `Neue Rechnung zu ${loaded.contract.number}`
                        : "Neue Rechnung"}
                </h2>
                <InvoiceForm
                    accounts={accounts}
                    contracts={contracts.map((entry) => ({
                        id: entry.id,
                        number: entry.number,
                        title: entry.title,
                        email: entry.email,
                    }))}
                    prefill={prefill}
                />
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
                        paidAt: entry.paidAt,
                        email: entry.email,
                        amount: entry.amount,
                        isCorrection: entry.cancelsInvoiceId !== null,
                        autoCollect: entry.collectedFrom !== null,
                    }))}
                />
            </div>
        </>
    );
}
