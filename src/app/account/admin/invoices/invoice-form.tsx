"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import FormStatus from "@/lib/components/account/form-status";
import LineItemFields, {
    type LineItemValue,
} from "@/lib/components/account/line-item-fields";
import SelectField from "@/lib/components/account/select-field";
import { createInvoice, type InvoiceState } from "./actions";

const initialState: InvoiceState = { status: "idle" };

export type ContractOption = {
    id: string;
    number: string;
    title: string;
    email: string;
};

/** What `?contract=` fills in — the whole form, not just the link. */
export type InvoicePrefill = {
    userId: string;
    contractId: string;
    items: LineItemValue[];
    servicePeriodStart: string;
    servicePeriodEnd: string;
};

export default function InvoiceForm({
    accounts,
    contracts,
    prefill,
}: {
    accounts: { id: string; name: string | null; email: string }[];
    contracts: ContractOption[];
    prefill?: InvoicePrefill;
}) {
    const [state, formAction, pending] = useActionState(
        createInvoice,
        initialState,
    );

    return (
        // Every field is uncontrolled, so arriving from another contract must
        // remount the form — a changed defaultValue alone would not show.
        <form
            key={prefill?.contractId ?? "blank"}
            action={formAction}
            className="max-w-2xl space-y-6"
        >
            {state.status === "created" ? (
                <FormStatus
                    tone="success"
                    message="Entwurf angelegt. Die Rechnungsnummer wird erst beim Ausstellen vergeben."
                />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    Es gibt noch keine Konten.
                </p>
            ) : (
                <SelectField
                    id="userId"
                    label="Konto"
                    required
                    placeholder="Bitte wählen"
                    defaultValue={prefill?.userId}
                    options={accounts.map((account) => ({
                        value: account.id,
                        label: account.name
                            ? `${account.email} — ${account.name}`
                            : account.email,
                    }))}
                />
            )}

            <SelectField
                id="contractId"
                label="Vertrag"
                placeholder="Ohne Vertragsbezug"
                defaultValue={prefill?.contractId}
                options={contracts.map((contract) => ({
                    value: contract.id,
                    label: `${contract.number} — ${contract.title} (${contract.email})`,
                }))}
                help="Ordnet die Rechnung einem Vertrag zu und erscheint auf dessen Detailseite."
            />

            <div className="space-y-3">
                <Label htmlFor="introText">Einleitungstext</Label>
                <Textarea id="introText" name="introText" rows={2} />
            </div>

            <LineItemFields items={prefill?.items} />

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="servicePeriodStart">
                        Leistungszeitraum von
                    </Label>
                    <Input
                        id="servicePeriodStart"
                        name="servicePeriodStart"
                        type="date"
                        defaultValue={prefill?.servicePeriodStart}
                    />
                </div>
                <div className="space-y-3">
                    <Label htmlFor="servicePeriodEnd">bis</Label>
                    <Input
                        id="servicePeriodEnd"
                        name="servicePeriodEnd"
                        type="date"
                        defaultValue={prefill?.servicePeriodEnd}
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
