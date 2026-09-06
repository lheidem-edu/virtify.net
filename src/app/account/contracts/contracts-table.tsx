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

export type ContractRow = {
    id: string;
    number: string;
    title: string;
    status: keyof typeof CONTRACT_STATUS_LABEL;
    serviceReadyAt: Date | null;
    minimumTermMonths: number;
    monthlyPriceCents: number;
    terminatedTo: Date | null;
};

const columns: ColumnDef<ContractRow, unknown>[] = [
    { accessorKey: "title", header: "Bezeichnung" },
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
        accessorKey: "minimumTermMonths",
        header: "Laufzeit",
        cell: ({ row }) => `${row.original.minimumTermMonths} Monate`,
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

export default function ContractsTable({ rows }: { rows: ContractRow[] }) {
    return (
        <DataTable
            columns={columns}
            data={rows}
            searchPlaceholder="Bezeichnung oder Nummer suchen …"
            emptyMessage="Für dein Konto ist derzeit kein Vertrag hinterlegt."
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
