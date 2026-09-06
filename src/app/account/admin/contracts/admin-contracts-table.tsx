"use client";

import type { ColumnDef } from "@tanstack/react-table";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    CONTRACT_STATUS_LABEL,
    CONTRACT_STATUS_TONE,
    formatDate,
    formatPrice,
} from "@/lib/format";

export type AdminContractRow = {
    id: string;
    number: string;
    title: string;
    status: keyof typeof CONTRACT_STATUS_LABEL;
    serviceReadyAt: Date | null;
    minimumTermMonths: number;
    monthlyPriceCents: number;
    email: string;
};

const columns: ColumnDef<AdminContractRow, unknown>[] = [
    { accessorKey: "title", header: "Bezeichnung" },
    { accessorKey: "email", header: "Konto" },
    {
        accessorKey: "number",
        header: "Vertrags-Nr.",
        cell: ({ row }) => (
            <span className="font-mono text-xs break-all">
                {row.original.number}
            </span>
        ),
    },
    {
        accessorKey: "monthlyPriceCents",
        header: "Monatlich",
        cell: ({ row }) => (
            <span className="font-mono">
                {formatPrice(row.original.monthlyPriceCents)}
            </span>
        ),
    },
    {
        accessorKey: "serviceReadyAt",
        header: "Service-Readiness",
        cell: ({ row }) => formatDate(row.original.serviceReadyAt),
        sortingFn: (a, b) =>
            (a.original.serviceReadyAt?.getTime() ?? 0) -
            (b.original.serviceReadyAt?.getTime() ?? 0),
    },
    {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
            <StatusBadge
                label={CONTRACT_STATUS_LABEL[row.original.status]}
                tone={CONTRACT_STATUS_TONE[row.original.status]}
            />
        ),
        filterFn: (row, id, value) => row.getValue(id) === value,
    },
];

export default function AdminContractsTable({
    rows,
}: {
    rows: AdminContractRow[];
}) {
    return (
        <DataTable
            columns={columns}
            data={rows}
            searchPlaceholder="Bezeichnung, Konto oder Nummer suchen …"
            emptyMessage="Noch keine Verträge angelegt."
            filters={[
                {
                    columnId: "status",
                    label: "Status",
                    options: Object.entries(CONTRACT_STATUS_LABEL).map(
                        ([value, label]) => ({ value, label }),
                    ),
                },
            ]}
        />
    );
}
