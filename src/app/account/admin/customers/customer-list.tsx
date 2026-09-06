"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import DataTable from "@/lib/components/account/data-table";
import StatusBadge from "@/lib/components/account/status-badge";
import { type CustomerState, updateCustomer } from "./actions";

export type Customer = {
    id: string;
    customerNumber: number | null;
    email: string;
    emailVerified: boolean;
    role: string | null;
    name: string;
    company: string;
    street: string;
    postalCode: string;
    city: string;
    country: string;
    vatId: string;
    phone: string;
    buyerReference: string;
};

const EDITABLE = [
    { id: "name", label: "Name" },
    { id: "company", label: "Firma" },
    { id: "street", label: "Straße" },
    { id: "postalCode", label: "PLZ" },
    { id: "city", label: "Ort" },
    { id: "country", label: "Land" },
    { id: "vatId", label: "USt-IdNr." },
    { id: "phone", label: "Telefon" },
    { id: "buyerReference", label: "Käuferreferenz (Leitweg-ID)" },
] as const;

const initialState: CustomerState = { status: "idle" };

function CustomerForm({ customer }: { customer: Customer }) {
    const [state, formAction, pending] = useActionState(
        updateCustomer,
        initialState,
    );

    return (
        <form action={formAction} className="mt-6 max-w-xl space-y-5">
            <input type="hidden" name="userId" value={customer.id} />

            {state.status === "saved" ? (
                <p className="rounded-lg border p-3 text-xs text-zinc-300">
                    Gespeichert.
                </p>
            ) : null}
            {state.status === "error" ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    {state.message}
                </p>
            ) : null}

            <div className="grid gap-5 sm:grid-cols-2">
                {EDITABLE.map((field) => (
                    <div key={field.id} className="space-y-2">
                        <Label htmlFor={`${customer.id}-${field.id}`}>
                            {field.label}
                        </Label>
                        <Input
                            id={`${customer.id}-${field.id}`}
                            name={field.id}
                            defaultValue={customer[field.id]}
                            maxLength={200}
                        />
                    </div>
                ))}
            </div>

            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
            >
                {pending ? "…" : "Speichern"}
            </Button>
        </form>
    );
}

const columns: ColumnDef<Customer, unknown>[] = [
    {
        accessorKey: "customerNumber",
        header: "Kunden-Nr.",
        cell: ({ row }) => (
            <span className="font-mono">
                {row.original.customerNumber ?? "—"}
            </span>
        ),
    },
    {
        accessorKey: "email",
        header: "E-Mail",
        cell: ({ row }) => (
            <span className="font-mono text-xs">{row.original.email}</span>
        ),
    },
    {
        accessorKey: "company",
        header: "Firma",
        cell: ({ row }) => row.original.company || "—",
    },
    { accessorKey: "name", header: "Name" },
    {
        accessorKey: "city",
        header: "Ort",
        cell: ({ row }) => row.original.city || "—",
    },
    {
        id: "state",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => (
            <div className="flex gap-2">
                {row.original.role === "admin" ? (
                    <StatusBadge label="Admin" tone="positive" />
                ) : null}
                {row.original.emailVerified ? null : (
                    <StatusBadge label="Nicht bestätigt" tone="warning" />
                )}
            </div>
        ),
    },
];

export default function CustomerList({ customers }: { customers: Customer[] }) {
    const [open, setOpen] = useState<Customer | null>(null);

    const withActions: ColumnDef<Customer, unknown>[] = [
        ...columns,
        {
            id: "actions",
            header: "",
            enableSorting: false,
            cell: ({ row }) => (
                <div className="flex justify-end">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                            setOpen(
                                open?.id === row.original.id
                                    ? null
                                    : row.original,
                            )
                        }
                    >
                        {open?.id === row.original.id
                            ? "Schließen"
                            : "Bearbeiten"}
                    </Button>
                </div>
            ),
        },
    ];

    return (
        <div className="space-y-8">
            <DataTable
                columns={withActions}
                data={customers}
                searchPlaceholder="Nummer, E-Mail, Firma oder Ort suchen …"
                emptyMessage="Es gibt noch keine Konten."
            />

            {open ? (
                <div className="rounded-lg border p-6">
                    <h3 className="text-sm font-medium tracking-tight">
                        {open.company || open.name || open.email} bearbeiten
                    </h3>
                    <CustomerForm key={open.id} customer={open} />
                </div>
            ) : null}
        </div>
    );
}
