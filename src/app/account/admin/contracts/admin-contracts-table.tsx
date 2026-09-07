"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    CONTRACT_STATUS_LABEL,
    CONTRACT_STATUS_TONE,
    formatDate,
    formatPrice,
} from "@/lib/format";
import {
    DeleteAction,
    ReactivateAction,
    TerminateAction,
} from "./contract-actions";

export type AdminContractRow = {
    id: string;
    number: string;
    title: string;
    status: keyof typeof CONTRACT_STATUS_LABEL;
    serviceReadyAt: Date | null;
    minimumTermMonths: number;
    monthlyPriceCents: number;
    terminatedTo: Date | null;
    email: string;
    /** Frühestmöglicher Kündigungstermin, auf dem Server gerechnet. */
    earliestTermination: string;
};

const linkClass =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

const columns: ColumnDef<AdminContractRow, unknown>[] = [
    {
        accessorKey: "title",
        header: "Bezeichnung",
        cell: ({ row }) => (
            <Link
                href={`/account/admin/contracts/${row.original.id}`}
                className={linkClass}
            >
                {row.original.title}
            </Link>
        ),
    },
    { accessorKey: "email", header: "Konto" },
    {
        accessorKey: "number",
        header: "Vertrags-Nr.",
        // Die Nummer ist die ULID selbst und damit zu lang für eine Spalte —
        // das Ende genügt zum Wiedererkennen, der Titel trägt sie vollständig.
        cell: ({ row }) => (
            <Link
                href={`/account/admin/contracts/${row.original.id}`}
                title={row.original.number}
                className={`font-mono text-xs ${linkClass}`}
            >
                …{row.original.number.slice(-8)}
            </Link>
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
            <div className="flex flex-col items-start gap-1">
                <StatusBadge
                    label={CONTRACT_STATUS_LABEL[row.original.status]}
                    tone={CONTRACT_STATUS_TONE[row.original.status]}
                />
                {row.original.terminatedTo ? (
                    <span className="text-xs text-muted-foreground">
                        zum {formatDate(row.original.terminatedTo)}
                    </span>
                ) : null}
            </div>
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
                    href={`/account/admin/invoices?contract=${row.original.id}`}
                    className={linkClass}
                >
                    Rechnung anlegen
                </Link>
                {row.original.status === "provisioning" ||
                row.original.status === "active" ? (
                    <TerminateAction
                        contractId={row.original.id}
                        earliestDate={row.original.earliestTermination}
                    />
                ) : null}
                {row.original.status === "terminated" ? (
                    <ReactivateAction contractId={row.original.id} />
                ) : null}
                <DeleteAction contractId={row.original.id} />
            </div>
        ),
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
