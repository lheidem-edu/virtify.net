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
import { SendOfferAction } from "./offer-actions";

export type AdminOfferRow = {
    id: string;
    number: string;
    title: string;
    status: keyof typeof OFFER_STATUS_LABEL;
    validUntil: Date | null;
    monthlyPriceCents: number;
    amount: number;
    email: string;
};

const columns: ColumnDef<AdminOfferRow, unknown>[] = [
    {
        accessorKey: "number",
        header: "Nummer",
        cell: ({ row }) => (
            <Link
                href={`/admin/offers/${row.original.id}`}
                className="font-mono underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
            >
                {row.original.number}
            </Link>
        ),
    },
    { accessorKey: "title", header: "Bezeichnung" },
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
            <div className="flex items-center justify-end gap-3">
                <Link
                    href={`/account/offers/${row.original.id}/pdf`}
                    className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                >
                    PDF
                </Link>
                {row.original.status === "draft" ? (
                    <SendOfferAction offerId={row.original.id} />
                ) : null}
            </div>
        ),
    },
];

export default function AdminOffersTable({ rows }: { rows: AdminOfferRow[] }) {
    return (
        <DataTable
            columns={columns}
            data={rows}
            searchPlaceholder="Nummer, Bezeichnung oder Konto suchen …"
            emptyMessage="Noch keine Angebote."
            filters={[
                {
                    columnId: "status",
                    label: "Status",
                    options: Object.entries(OFFER_STATUS_LABEL).map(
                        ([value, label]) => ({ value, label }),
                    ),
                },
            ]}
        />
    );
}
