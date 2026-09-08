"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import FormStatus from "@/lib/components/account/form-status";
import SelectField from "@/lib/components/account/select-field";
import { CONTRACT_STATUS_LABEL } from "@/lib/format";
import { type ContractState, createContract } from "./actions";

const initialState: ContractState = { status: "idle" };

const STATUS_OPTIONS = Object.entries(CONTRACT_STATUS_LABEL).map(
    ([value, label]) => ({ value, label }),
);

export default function ContractForm({
    accounts,
}: {
    accounts: { id: string; name: string; email: string }[];
}) {
    const [state, formAction, pending] = useActionState(
        createContract,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-6">
            {state.status === "created" ? (
                <FormStatus
                    tone="success"
                    message={`Angelegt: ${state.message}`}
                />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            {accounts.length === 0 ? (
                <p className="text-sm text-zinc-500">
                    Es gibt noch keine Konten, denen ein Vertrag zugeordnet
                    werden könnte.
                </p>
            ) : (
                <SelectField
                    id="userId"
                    label="Konto"
                    placeholder="Bitte wählen"
                    required
                    options={accounts.map((account) => ({
                        value: account.id,
                        label: account.name
                            ? `${account.email} — ${account.name}`
                            : account.email,
                    }))}
                />
            )}

            <div className="space-y-3">
                <Label htmlFor="title">Bezeichnung</Label>
                <Input
                    id="title"
                    name="title"
                    placeholder="z. B. KVM-Instanz"
                    required
                />
            </div>

            <SelectField
                id="status"
                label="Status"
                defaultValue="provisioning"
                options={STATUS_OPTIONS}
            />

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="monthlyPrice">
                        Monatliche Vergütung in EUR
                    </Label>
                    <Input
                        id="monthlyPrice"
                        name="monthlyPrice"
                        inputMode="decimal"
                        placeholder="9,95"
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        Ohne Umsatzsteuer (§ 19 UStG).
                    </p>
                </div>

                <div className="space-y-3">
                    <Label htmlFor="minimumTermMonths">
                        Grundlaufzeit in Monaten
                    </Label>
                    <Input
                        id="minimumTermMonths"
                        name="minimumTermMonths"
                        type="number"
                        min={0}
                        max={12}
                        defaultValue={12}
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        Höchstens zwölf Monate (§ 8 (1) AGB).
                    </p>
                </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="serviceReadyAt">Service-Readiness</Label>
                    <Input
                        id="serviceReadyAt"
                        name="serviceReadyAt"
                        type="date"
                    />
                    <p className="text-xs text-muted-foreground">
                        Ab hier laufen Grundlaufzeit und Abrechnung (§ 8 (1)
                        AGB).
                    </p>
                </div>

                <div className="space-y-3">
                    <Label htmlFor="terminatedTo">Gekündigt zum</Label>
                    <Input id="terminatedTo" name="terminatedTo" type="date" />
                    <p className="text-xs text-muted-foreground">
                        Nur für übernommene Verträge, die bereits gekündigt
                        sind.
                    </p>
                </div>
            </div>

            <div className="space-y-3">
                <Label htmlFor="note">Interne Notiz</Label>
                <Textarea id="note" name="note" rows={3} />
                <p className="text-xs text-muted-foreground">
                    Wird dem Kunden nicht angezeigt.
                </p>
            </div>

            <Button
                type="submit"
                size="lg"
                disabled={pending || accounts.length === 0}
            >
                {pending ? "…" : "Vertrag anlegen"}
            </Button>
        </form>
    );
}
