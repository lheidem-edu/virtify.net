import { asc } from "drizzle-orm";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { db, schema } from "@/lib/db";
import { listInvoices } from "@/lib/documents/repository";
import {
    formatDate,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
} from "@/lib/format";
import { IssueForm, StateForm } from "./invoice-actions";
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
                {invoices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Noch keine Rechnungen.
                    </p>
                ) : (
                    <ul className="max-w-3xl border-t">
                        {invoices.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b py-5"
                            >
                                <div>
                                    <p className="font-mono text-sm">
                                        {entry.number ?? "Entwurf"}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {entry.email}
                                        {entry.issuedAt
                                            ? ` · ausgestellt ${formatDate(entry.issuedAt)}`
                                            : ""}
                                        {entry.dueAt
                                            ? ` · fällig ${formatDate(entry.dueAt)}`
                                            : ""}
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                    <StatusBadge
                                        label={
                                            INVOICE_STATUS_LABEL[entry.status]
                                        }
                                        tone={INVOICE_STATUS_TONE[entry.status]}
                                    />
                                    <Link
                                        href={`/account/invoices/${entry.id}/pdf`}
                                        className="text-sm underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white"
                                    >
                                        PDF
                                    </Link>
                                    {entry.status === "draft" ? (
                                        <IssueForm invoiceId={entry.id} />
                                    ) : (
                                        <>
                                            <Link
                                                href={`/account/invoices/${entry.id}/xml`}
                                                className="text-sm underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white"
                                            >
                                                XML
                                            </Link>
                                            {entry.status ===
                                            "cancelled" ? null : (
                                                <StateForm
                                                    invoiceId={entry.id}
                                                    canMarkPaid={
                                                        entry.status ===
                                                        "issued"
                                                    }
                                                />
                                            )}
                                        </>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
