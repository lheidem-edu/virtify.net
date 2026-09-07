"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    daysOverdue,
    formatDate,
    formatPrice,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
    isOverdue,
} from "@/lib/format";
import PayActions from "./pay-actions";

export type InvoiceRow = {
    id: string;
    number: string | null;
    status: keyof typeof INVOICE_STATUS_LABEL;
    issuedAt: Date | null;
    dueAt: Date | null;
    paidAt: Date | null;
    email: string;
    amount: number;
    /** A correction is issued like any other invoice but reverses one. */
    isCorrection: boolean;
    /** Issued, not a correction, not settled — decided on the server. */
    canPay: boolean;
};

function buildColumns(
    stripe: boolean,
    paypal: boolean,
): ColumnDef<InvoiceRow, unknown>[] {
    return [
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
            cell: ({ row }) =>
                isOverdue(row.original) ? (
                    <span className="text-amber-400">
                        {formatDate(row.original.dueAt)}
                        <span className="block text-xs">
                            seit {daysOverdue(row.original.dueAt)} Tagen offen
                        </span>
                    </span>
                ) : (
                    formatDate(row.original.dueAt)
                ),
            sortingFn: (a, b) =>
                (a.original.dueAt?.getTime() ?? 0) -
                (b.original.dueAt?.getTime() ?? 0),
        },
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
            accessorKey: "status",
            header: "Status",
            // A correction carries status "issued" like any other invoice;
            // saying so would read as a second demand for money instead of
            // its reversal.
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
                <div className="flex flex-wrap items-center justify-end gap-4">
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
                    {row.original.canPay ? (
                        <PayActions
                            invoiceId={row.original.id}
                            stripe={stripe}
                            paypal={paypal}
                        />
                    ) : null}
                </div>
            ),
        },
    ];
}

export default function InvoicesTable({
    rows,
    stripe,
    paypal,
}: {
    rows: InvoiceRow[];
    stripe: boolean;
    paypal: boolean;
}) {
    const columns = useMemo(
        () => buildColumns(stripe, paypal),
        [stripe, paypal],
    );

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
