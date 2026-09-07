"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    formatDate,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
} from "@/lib/format";

export type InvoiceRow = {
    id: string;
    number: string | null;
    status: keyof typeof INVOICE_STATUS_LABEL;
    issuedAt: Date | null;
    dueAt: Date | null;
    email: string;
    amount: number;
    /** A correction is issued like any other invoice but reverses one. */
    isCorrection: boolean;
};

const columns: ColumnDef<InvoiceRow, unknown>[] = [
    {
        accessorKey: "number",
        header: "Nummer",
        cell: ({ row }) => (
            <span className="font-mono">{row.original.number ?? "—"}</span>
        ),
    },
    {
        accessorKey: "issuedAt",
        header: "Ausgestellt",
        cell: ({ row }) => formatDate(row.original.issuedAt),
        // Sort on the timestamp, not the formatted string, or 01.02. would
        // sort before 09.01.
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
        accessorKey: "amount",
        header: "Betrag",
        cell: ({ row }) => (
            <span className="font-mono">
                {(row.original.amount / 100).toLocaleString("de-DE", {
                    style: "currency",
                    currency: "EUR",
                })}
            </span>
        ),
    },
    {
        accessorKey: "status",
        header: "Status",
        // A correction carries status "issued" like any other invoice; saying
        // so would read as a second demand for money instead of its reversal.
        cell: ({ row }) =>
            row.original.isCorrection ? (
                <StatusBadge label="Korrektur" tone="neutral" />
            ) : (
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
            <div className="flex justify-end gap-4">
                <Link
                    href={`/account/invoices/${row.original.id}/pdf`}
                    className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                >
                    PDF
                </Link>
                <Link
                    href={`/account/invoices/${row.original.id}/xml`}
                    className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                >
                    XRechnung
                </Link>
            </div>
        ),
    },
];

export default function InvoicesTable({ rows }: { rows: InvoiceRow[] }) {
    return (
        <DataTable
            columns={columns}
            data={rows}
            searchPlaceholder="Nummer oder Datum suchen …"
            emptyMessage="Es liegen noch keine Rechnungen vor."
            filters={[
                {
                    columnId: "status",
                    label: "Status",
                    options: Object.entries(INVOICE_STATUS_LABEL)
                        .filter(([value]) => value !== "draft")
                        .map(([value, label]) => ({ value, label })),
                },
            ]}
        />
    );
}
