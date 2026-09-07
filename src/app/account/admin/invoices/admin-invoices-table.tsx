"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    formatDate,
    formatPrice,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
} from "@/lib/format";
import { IssueForm, MarkPaidForm } from "./invoice-actions";

export type AdminInvoiceRow = {
    id: string;
    number: string | null;
    status: keyof typeof INVOICE_STATUS_LABEL;
    issuedAt: Date | null;
    dueAt: Date | null;
    email: string;
    amount: number;
    /** A correction settles the invoice it reverses; nothing on it falls due. */
    isCorrection: boolean;
    /**
     * The contract behind the invoice carries a stored payment method, so
     * issuing collects the amount and the row turns paid on its own.
     */
    autoCollect: boolean;
};

const columns: ColumnDef<AdminInvoiceRow, unknown>[] = [
    {
        accessorKey: "number",
        header: "Nummer",
        cell: ({ row }) => (
            <Link
                href={`/account/admin/invoices/${row.original.id}`}
                className="font-mono underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
            >
                {row.original.number ?? "Entwurf"}
            </Link>
        ),
    },
    { accessorKey: "email", header: "Konto" },
    {
        accessorKey: "amount",
        header: "Betrag",
        cell: ({ row }) => (
            <span className="font-mono">
                {formatPrice(row.original.amount)}
            </span>
        ),
    },
    {
        accessorKey: "issuedAt",
        header: "Ausgestellt",
        cell: ({ row }) => formatDate(row.original.issuedAt),
        sortingFn: (a, b) =>
            (a.original.issuedAt?.getTime() ?? 0) -
            (b.original.issuedAt?.getTime() ?? 0),
    },
    {
        accessorKey: "dueAt",
        header: "Fällig",
        cell: ({ row }) => formatDate(row.original.dueAt),
        sortingFn: (a, b) =>
            (a.original.dueAt?.getTime() ?? 0) -
            (b.original.dueAt?.getTime() ?? 0),
    },
    {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
            <div className="flex items-center gap-2">
                <StatusBadge
                    label={INVOICE_STATUS_LABEL[row.original.status]}
                    tone={INVOICE_STATUS_TONE[row.original.status]}
                />
                {/* Quiet on purpose: it explains why a row may turn paid by
                    itself, it is not another thing to click. */}
                {row.original.autoCollect ? (
                    <span
                        title="Wird über das hinterlegte Zahlungsmittel automatisch eingezogen."
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    >
                        <RefreshCw className="size-3" aria-hidden />
                        Einzug
                    </span>
                ) : null}
            </div>
        ),
        filterFn: (row, id, value) => row.getValue(id) === value,
    },
    {
        // Only what is done in passing lives here; correction, resend and delete
        // ask for a confirmation and belong on the detail page.
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
            <div className="flex flex-wrap items-center justify-end gap-3">
                <Link
                    href={`/account/invoices/${row.original.id}/pdf`}
                    className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                >
                    PDF
                </Link>
                {row.original.status === "draft" ? (
                    <IssueForm invoiceId={row.original.id} />
                ) : (
                    <>
                        <Link
                            href={`/account/invoices/${row.original.id}/xml`}
                            className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                        >
                            XML
                        </Link>
                        {row.original.status === "issued" &&
                        !row.original.isCorrection ? (
                            <MarkPaidForm invoiceId={row.original.id} />
                        ) : null}
                    </>
                )}
            </div>
        ),
    },
];

export default function AdminInvoicesTable({
    rows,
}: {
    rows: AdminInvoiceRow[];
}) {
    return (
        <DataTable
            columns={columns}
            data={rows}
            searchPlaceholder="Nummer oder Konto suchen …"
            emptyMessage="Noch keine Rechnungen."
            filters={[
                {
                    columnId: "status",
                    label: "Status",
                    options: Object.entries(INVOICE_STATUS_LABEL).map(
                        ([value, label]) => ({ value, label }),
                    ),
                },
            ]}
        />
    );
}
