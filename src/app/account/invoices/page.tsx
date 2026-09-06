import Link from "next/link";
import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { listInvoices } from "@/lib/documents/repository";
import {
    formatDate,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
} from "@/lib/format";

export default async function Page() {
    const session = await requireSession();
    const invoices = (await listInvoices(session.user.id, false)).filter(
        // Drafts are working state on our side and never shown to customers.
        (entry) => entry.status !== "draft",
    );

    return (
        <>
            <PageHeader
                title="Rechnungen"
                intro="Alle ausgestellten Rechnungen als PDF und als XRechnung."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                {invoices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Es liegen noch keine Rechnungen vor.
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
                                        {entry.number}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Ausgestellt {formatDate(entry.issuedAt)}
                                        {entry.dueAt
                                            ? ` · fällig ${formatDate(entry.dueAt)}`
                                            : ""}
                                    </p>
                                </div>
                                <div className="flex items-center gap-4">
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
                                    <Link
                                        href={`/account/invoices/${entry.id}/xml`}
                                        className="text-sm underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white"
                                    >
                                        XRechnung
                                    </Link>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
