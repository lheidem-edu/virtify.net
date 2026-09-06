"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import {
    formatDate,
    formatPrice,
    OFFER_STATUS_LABEL,
    OFFER_STATUS_TONE,
} from "@/lib/format";
import DecideForm from "./decide-form";

export type OfferRow = {
    id: string;
    number: string;
    title: string;
    status: keyof typeof OFFER_STATUS_LABEL;
    validUntil: Date | null;
    monthlyPriceCents: number;
    amount: number;
};

const columns: ColumnDef<OfferRow, unknown>[] = [
    { accessorKey: "title", header: "Bezeichnung" },
    {
        accessorKey: "number",
        header: "Nummer",
        cell: ({ row }) => (
            <span className="font-mono">{row.original.number}</span>
        ),
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
        accessorKey: "monthlyPriceCents",
        header: "Monatlich",
        cell: ({ row }) => (
            <span className="font-mono">
                {formatPrice(row.original.monthlyPriceCents)}
            </span>
        ),
    },
    {
        accessorKey: "validUntil",
        header: "Gültig bis",
        cell: ({ row }) => formatDate(row.original.validUntil),
        sortingFn: (a, b) =>
            (a.original.validUntil?.getTime() ?? 0) -
            (b.original.validUntil?.getTime() ?? 0),
    },
    {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
            <StatusBadge
                label={OFFER_STATUS_LABEL[row.original.status]}
                tone={OFFER_STATUS_TONE[row.original.status]}
            />
        ),
        filterFn: (row, id, value) => row.getValue(id) === value,
    },
    {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
            <div className="flex items-center justify-end gap-4">
                <Link
                    href={`/account/offers/${row.original.id}/pdf`}
                    className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                >
                    PDF
                </Link>
                {row.original.status === "sent" ? (
                    <DecideForm offerId={row.original.id} />
                ) : null}
            </div>
        ),
    },
];

export default function OffersTable({ rows }: { rows: OfferRow[] }) {
    return (
        <DataTable
            columns={columns}
            data={rows}
            searchPlaceholder="Bezeichnung oder Nummer suchen …"
            emptyMessage="Es liegen derzeit keine Angebote vor."
            filters={[
                {
                    columnId: "status",
                    label: "Status",
                    options: Object.entries(OFFER_STATUS_LABEL)
                        .filter(([value]) => value !== "draft")
                        .map(([value, label]) => ({ value, label })),
                },
            ]}
        />
    );
}
