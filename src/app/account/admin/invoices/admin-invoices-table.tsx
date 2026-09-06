"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    formatDate,
    formatPrice,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
} from "@/lib/format";
import { IssueForm, StateForm } from "./invoice-actions";

export type AdminInvoiceRow = {
    id: string;
    number: string | null;
    status: keyof typeof INVOICE_STATUS_LABEL;
    issuedAt: Date | null;
    dueAt: Date | null;
    email: string;
    amount: number;
};

const columns: ColumnDef<AdminInvoiceRow, unknown>[] = [
    {
        accessorKey: "number",
        header: "Nummer",
        cell: ({ row }) => (
            <span className="font-mono">
                {row.original.number ?? "Entwurf"}
            </span>
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
            <StatusBadge
                label={INVOICE_STATUS_LABEL[row.original.status]}
                tone={INVOICE_STATUS_TONE[row.original.status]}
            />
        ),
        filterFn: (row, id, value) => row.getValue(id) === value,
    },
    {
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
                        {row.original.status === "cancelled" ? null : (
                            <StateForm
                                invoiceId={row.original.id}
                                canMarkPaid={row.original.status === "issued"}
                            />
                        )}
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
