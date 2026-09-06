"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import AccountSelect from "@/lib/components/account/account-select";
import LineItemFields from "@/lib/components/account/line-item-fields";
import { createInvoice, type InvoiceState } from "./actions";

const initialState: InvoiceState = { status: "idle" };

export default function InvoiceForm({
    accounts,
}: {
    accounts: { id: string; name: string | null; email: string }[];
}) {
    const [state, formAction, pending] = useActionState(
        createInvoice,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-6">
            {state.status === "created" ? (
                <p className="rounded-lg border p-4 text-sm text-zinc-300">
                    Entwurf angelegt. Die Rechnungsnummer wird erst beim
                    Ausstellen vergeben.
                </p>
            ) : null}
            {state.status === "error" ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                    {state.message}
                </p>
            ) : null}

            <AccountSelect accounts={accounts} />

            <div className="space-y-3">
                <Label htmlFor="introText">Einleitungstext</Label>
                <Textarea id="introText" name="introText" rows={2} />
            </div>

            <LineItemFields />

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="servicePeriodStart">
                        Leistungszeitraum von
                    </Label>
                    <Input
                        id="servicePeriodStart"
                        name="servicePeriodStart"
                        type="date"
                    />
                </div>
                <div className="space-y-3">
                    <Label htmlFor="servicePeriodEnd">bis</Label>
                    <Input
                        id="servicePeriodEnd"
                        name="servicePeriodEnd"
                        type="date"
                    />
                </div>
            </div>

            <div className="space-y-3">
                <Label htmlFor="note">Schlussbemerkung</Label>
                <Textarea id="note" name="note" rows={2} />
            </div>

            <Button
                type="submit"
                size="lg"
                disabled={pending || accounts.length === 0}
            >
                {pending ? "…" : "Entwurf anlegen"}
            </Button>
        </form>
    );
}
