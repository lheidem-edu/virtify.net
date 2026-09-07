"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import FormStatus from "@/lib/components/account/form-status";
import SelectField from "@/lib/components/account/select-field";
import { CONTRACT_STATUS_LABEL } from "@/lib/format";
import { type ContractState, updateContract } from "../actions";

const initialState: ContractState = { status: "idle" };

/**
 * "Gekündigt" is missing on purpose: that state carries a date and a
 * confirmation to the customer, so it is reached through Kündigen and left
 * through Kündigung zurücknehmen. A contract already in it keeps the entry,
 * otherwise the select could not show its own current value.
 */
function statusOptions(current: string) {
    return Object.entries(CONTRACT_STATUS_LABEL)
        .filter(([value]) => value !== "terminated" || value === current)
        .map(([value, label]) => ({ value, label }));
}

export default function ContractEditForm({
    contractId,
    title,
    status,
    monthlyPrice,
    minimumTermMonths,
    serviceReadyAt,
    note,
    canEditTerms,
}: {
    contractId: string;
    title: string;
    status: string;
    /** Als deutsche Dezimalzahl, wie das Feld sie erwartet. */
    monthlyPrice: string;
    minimumTermMonths: number;
    /** Als `yyyy-mm-dd` oder leer. */
    serviceReadyAt: string;
    note: string;
    /**
     * Vergütung und Grundlaufzeit stehen fest, sobald eine Rechnung oder ein
     * Angebot sie nennt — die Felder bleiben dann nur noch lesbar.
     */
    canEditTerms: boolean;
}) {
    const [state, formAction, pending] = useActionState(
        updateContract,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-6">
            <input type="hidden" name="contractId" value={contractId} />

            {state.status === "saved" ? (
                <FormStatus tone="success" message="Gespeichert." />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="space-y-3">
                <Label htmlFor="title">Bezeichnung</Label>
                <Input id="title" name="title" defaultValue={title} required />
            </div>

            <SelectField
                id="status"
                label="Status"
                defaultValue={status}
                options={statusOptions(status)}
                help="Eine Kündigung wird über „Kündigen“ erfasst — nur dort wird das Vertragsende gesetzt und bestätigt."
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
                        defaultValue={monthlyPrice}
                        readOnly={!canEditTerms}
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        {canEditTerms
                            ? "Ohne Umsatzsteuer (§ 19 UStG)."
                            : "Festgeschrieben, weil eine Rechnung oder ein Angebot diese Konditionen nennt."}
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
                        defaultValue={minimumTermMonths}
                        readOnly={!canEditTerms}
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        Höchstens zwölf Monate (§ 8 (1) AGB).
                    </p>
                </div>
            </div>

            <div className="space-y-3">
                <Label htmlFor="serviceReadyAt">Service-Readiness</Label>
                <Input
                    id="serviceReadyAt"
                    name="serviceReadyAt"
                    type="date"
                    defaultValue={serviceReadyAt}
                />
                <p className="text-xs text-muted-foreground">
                    Ab diesem Tag laufen Grundlaufzeit und Abrechnung (§ 8 (1)
                    AGB) — ohne ihn beginnt die Laufzeit nicht.
                </p>
            </div>

            <div className="space-y-3">
                <Label htmlFor="note">Interne Notiz</Label>
                <Textarea id="note" name="note" rows={3} defaultValue={note} />
                <p className="text-xs text-muted-foreground">
                    Wird dem Kunden nicht angezeigt.
                </p>
            </div>

            <Button type="submit" size="lg" disabled={pending}>
                {pending ? "…" : "Speichern"}
            </Button>
        </form>
    );
}
