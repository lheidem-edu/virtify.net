"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    CONTRACT_STATUS_LABEL,
    CONTRACT_STATUS_TONE,
    formatDate,
    formatPrice,
} from "@/lib/format";
import {
    ContractCollection,
    type StoredMethodOption,
} from "../payment-methods/payment-method-actions";

export type ContractRow = {
    id: string;
    number: string;
    title: string;
    status: keyof typeof CONTRACT_STATUS_LABEL;
    serviceReadyAt: Date | null;
    minimumTermMonths: number;
    monthlyPriceCents: number;
    terminatedTo: Date | null;
    /** Set when this contract's invoices are collected automatically. */
    paymentMethodId: string | null;
    paymentMethodLabel: string | null;
};

/** Only a contract that still produces invoices can be collected from. */
function billable(status: ContractRow["status"]) {
    return status === "provisioning" || status === "active";
}

function buildColumns(
    methods: StoredMethodOption[],
): ColumnDef<ContractRow, unknown>[] {
    return [
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
            accessorKey: "terminatedTo",
            header: "Gekündigt zum",
            cell: ({ row }) => formatDate(row.original.terminatedTo),
            sortingFn: (a, b) =>
                (a.original.terminatedTo?.getTime() ?? 0) -
                (b.original.terminatedTo?.getTime() ?? 0),
        },
        {
            accessorKey: "paymentMethodLabel",
            header: "Zahlung",
            cell: ({ row }) =>
                row.original.paymentMethodLabel ? (
                    <span className="text-xs">
                        Einzug über {row.original.paymentMethodLabel}
                    </span>
                ) : (
                    <span className="text-xs text-muted-foreground">
                        Zahlung durch dich
                    </span>
                ),
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
        {
            id: "actions",
            header: "",
            enableSorting: false,
            // Switching the collection on needs a contract that still bills;
            // switching it off must stay reachable whatever the status, since
            // the terms promise it can be withdrawn at any time.
            cell: ({ row }) =>
                billable(row.original.status) ||
                row.original.paymentMethodId ? (
                    <div className="flex justify-end">
                        <ContractCollection
                            contractId={row.original.id}
                            methods={methods}
                            currentMethodId={row.original.paymentMethodId}
                        />
                    </div>
                ) : null,
        },
    ];
}

export default function ContractsTable({
    rows,
    methods,
}: {
    rows: ContractRow[];
    /** The customer's stored payment methods, offered when switching on. */
    methods: StoredMethodOption[];
}) {
    const columns = useMemo(() => buildColumns(methods), [methods]);

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
