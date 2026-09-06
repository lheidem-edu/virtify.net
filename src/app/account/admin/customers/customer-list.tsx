"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import StatusBadge from "@/lib/components/account/status-badge";
import { type CustomerState, updateCustomer } from "./actions";

export type Customer = {
    id: string;
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

export default function CustomerList({ customers }: { customers: Customer[] }) {
    const [open, setOpen] = useState<string | null>(null);

    if (customers.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                Es gibt noch keine Konten.
            </p>
        );
    }

    return (
        <ul className="max-w-3xl border-t">
            {customers.map((customer) => (
                <li key={customer.id} className="border-b py-5">
                    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                        <div>
                            <p className="font-mono text-sm">
                                {customer.email}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {customer.company || customer.name || "—"}
                            </p>
                        </div>
                        <div className="flex items-center gap-3">
                            {customer.role === "admin" ? (
                                <StatusBadge label="Admin" tone="positive" />
                            ) : null}
                            {customer.emailVerified ? null : (
                                <StatusBadge
                                    label="Nicht bestätigt"
                                    tone="warning"
                                />
                            )}
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                    setOpen(
                                        open === customer.id
                                            ? null
                                            : customer.id,
                                    )
                                }
                            >
                                {open === customer.id
                                    ? "Schließen"
                                    : "Bearbeiten"}
                            </Button>
                        </div>
                    </div>

                    {open === customer.id ? (
                        <CustomerForm customer={customer} />
                    ) : null}
                </li>
            ))}
        </ul>
    );
}
