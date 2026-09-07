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
import { type InvoiceState, updateInvoice } from "../actions";
import type { ContractOption } from "../invoice-form";

const initialState: InvoiceState = { status: "idle" };

export type InvoiceDraft = {
    id: string;
    userId: string;
    contractId: string;
    introText: string;
    note: string;
    /** Already `yyyy-mm-dd`, as an <input type="date"> wants it. */
    servicePeriodStart: string;
    servicePeriodEnd: string;
    items: LineItemValue[];
};

export default function InvoiceEditForm({
    invoice,
    accounts,
    contracts,
}: {
    invoice: InvoiceDraft;
    accounts: { id: string; name: string | null; email: string }[];
    contracts: ContractOption[];
}) {
    const [state, formAction, pending] = useActionState(
        updateInvoice,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-6">
            <input type="hidden" name="invoiceId" value={invoice.id} />

            {state.status === "saved" ? (
                <FormStatus tone="success" message="Gespeichert." />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <SelectField
                id="userId"
                label="Konto"
                required
                defaultValue={invoice.userId}
                options={accounts.map((account) => ({
                    value: account.id,
                    label: account.name
                        ? `${account.email} — ${account.name}`
                        : account.email,
                }))}
            />

            <SelectField
                id="contractId"
                label="Vertrag"
                placeholder="Ohne Vertragsbezug"
                defaultValue={invoice.contractId}
                options={contracts.map((contract) => ({
                    value: contract.id,
                    label: `${contract.number} — ${contract.title} (${contract.email})`,
                }))}
                help="Ordnet die Rechnung einem Vertrag zu und erscheint auf dessen Detailseite."
            />

            <div className="space-y-3">
                <Label htmlFor="introText">Einleitungstext</Label>
                <Textarea
                    id="introText"
                    name="introText"
                    rows={2}
                    defaultValue={invoice.introText}
                />
            </div>

            <LineItemFields items={invoice.items} />

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="servicePeriodStart">
                        Leistungszeitraum von
                    </Label>
                    <Input
                        id="servicePeriodStart"
                        name="servicePeriodStart"
                        type="date"
                        defaultValue={invoice.servicePeriodStart}
                    />
                </div>
                <div className="space-y-3">
                    <Label htmlFor="servicePeriodEnd">bis</Label>
                    <Input
                        id="servicePeriodEnd"
                        name="servicePeriodEnd"
                        type="date"
                        defaultValue={invoice.servicePeriodEnd}
                    />
                </div>
            </div>

            <div className="space-y-3">
                <Label htmlFor="note">Schlussbemerkung</Label>
                <Textarea
                    id="note"
                    name="note"
                    rows={2}
                    defaultValue={invoice.note}
                />
            </div>

            <Button type="submit" size="lg" disabled={pending}>
                {pending ? "…" : "Entwurf speichern"}
            </Button>
        </form>
    );
}
