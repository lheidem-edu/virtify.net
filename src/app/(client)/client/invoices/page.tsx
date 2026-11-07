import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import {
    formatDate,
    formatPrice,
    type INVOICE_STATUS_LABEL,
} from "@/lib/format";
import {
    listCreditNotes,
    listInvoices,
} from "@/server/billing/invoices/repository";
import { getCurrentCustomer } from "@/server/customers/current";
import { paypalEnabled, stripeEnabled } from "@/server/payments/config";
import InvoicesTable from "./invoices-table";

export default async function Page() {
    const { customer } = await getCurrentCustomer();

    // Which providers exist is a server-side question; the table only ever
    // sees the two booleans.
    const stripe = stripeEnabled();
    const paypal = paypalEnabled();

    const creditNotes = await listCreditNotes(customer.id, false);

    const invoices = (await listInvoices(customer.id, false))
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
            credited: entry.creditedCents,
            canPay: entry.status === "unpaid" && !entry.paidAt,
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

            {creditNotes.length > 0 ? (
                <div className="border-t px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-2 font-medium text-sm tracking-tight">
                        Rechnungskorrekturen
                    </h2>
                    <p className="mb-6 max-w-2xl text-muted-foreground text-sm leading-7">
                        Eine Korrektur nimmt eine Rechnung ganz oder teilweise
                        zurück. Sie trägt eine eigene Nummer; zu zahlen ist
                        darauf nichts.
                    </p>
                    <ul className="max-w-3xl divide-y rounded-lg border">
                        {creditNotes.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 text-sm"
                            >
                                <span className="font-mono">
                                    {entry.number}
                                </span>
                                <span className="text-muted-foreground">
                                    zu {entry.invoiceNumber ?? "—"} ·{" "}
                                    {formatDate(entry.issuedAt)}
                                </span>
                                <span className="font-mono">
                                    {formatPrice(entry.grossCents)}
                                </span>
                                <span className="flex gap-4">
                                    <Link
                                        href={`/client/credit-notes/${entry.id}/pdf`}
                                        className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                                    >
                                        PDF
                                    </Link>
                                    <Link
                                        href={`/client/credit-notes/${entry.id}/xml`}
                                        className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                                    >
                                        XRechnung
                                    </Link>
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </>
    );
}
