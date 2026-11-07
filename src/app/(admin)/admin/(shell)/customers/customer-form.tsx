"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CustomerState } from "./actions";

export type CustomerFields = {
    id?: string;
    kind: string;
    name: string;
    company: string;
    street: string;
    postalCode: string;
    city: string;
    country: string;
    vatId: string;
    phone: string;
    buyerReference: string;
    language: string;
    status: string;
    notes: string;
};

export const EMPTY_CUSTOMER: CustomerFields = {
    kind: "private",
    name: "",
    company: "",
    street: "",
    postalCode: "",
    city: "",
    country: "DE",
    vatId: "",
    phone: "",
    buyerReference: "",
    language: "de",
    status: "active",
    notes: "",
};

const TEXT_FIELDS = [
    { id: "name", label: "Name", required: true },
    { id: "company", label: "Firma" },
    { id: "street", label: "Straße und Hausnummer" },
    { id: "postalCode", label: "PLZ" },
    { id: "city", label: "Ort" },
    { id: "country", label: "Land (ISO, z. B. DE)" },
    { id: "vatId", label: "USt-IdNr." },
    { id: "phone", label: "Telefon" },
    { id: "buyerReference", label: "Käuferreferenz (Leitweg-ID)" },
] as const;

const initial: CustomerState = { status: "idle" };

export default function CustomerForm({
    action,
    customer,
    submitLabel,
}: {
    action: (state: CustomerState, data: FormData) => Promise<CustomerState>;
    customer: CustomerFields;
    submitLabel: string;
}) {
    const [state, formAction, pending] = useActionState(action, initial);
    const prefix = customer.id ?? "new";

    return (
        <form action={formAction} className="max-w-3xl space-y-6">
            {customer.id ? (
                <input type="hidden" name="customerId" value={customer.id} />
            ) : null}

            {state.status === "saved" ? (
                <FormStatus tone="success" message="Gespeichert." />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="grid gap-5 sm:grid-cols-2">
                <SelectField
                    id={`${prefix}-kind`}
                    name="kind"
                    label="Art"
                    defaultValue={customer.kind}
                    options={[
                        { value: "private", label: "Privatperson" },
                        { value: "company", label: "Firma" },
                    ]}
                />
                <SelectField
                    id={`${prefix}-status`}
                    name="status"
                    label="Status"
                    defaultValue={customer.status}
                    options={[
                        { value: "active", label: "Aktiv" },
                        { value: "suspended", label: "Gesperrt" },
                        { value: "closed", label: "Beendet" },
                    ]}
                />

                {TEXT_FIELDS.map((field) => (
                    <div key={field.id} className="space-y-2">
                        <Label htmlFor={`${prefix}-${field.id}`}>
                            {field.label}
                        </Label>
                        <Input
                            id={`${prefix}-${field.id}`}
                            name={field.id}
                            defaultValue={customer[field.id]}
                            required={"required" in field && field.required}
                            maxLength={200}
                        />
                    </div>
                ))}

                <SelectField
                    id={`${prefix}-language`}
                    name="language"
                    label="Sprache"
                    defaultValue={customer.language}
                    options={[
                        { value: "de", label: "Deutsch" },
                        { value: "en", label: "Englisch" },
                    ]}
                />
            </div>

            <div className="space-y-2">
                <Label htmlFor={`${prefix}-notes`}>Interne Notiz</Label>
                <Textarea
                    id={`${prefix}-notes`}
                    name="notes"
                    defaultValue={customer.notes}
                    rows={3}
                    maxLength={5000}
                />
                <p className="text-xs text-muted-foreground">
                    Nur für die Verwaltung. Der Kunde sieht sie nicht.
                </p>
            </div>

            <Button type="submit" disabled={pending}>
                {pending ? "Speichert …" : submitLabel}
            </Button>
        </form>
    );
}
