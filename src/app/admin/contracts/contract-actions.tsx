"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ConfirmAction from "@/lib/components/account/confirm-action";
import {
    type ContractState,
    deleteContract,
    reactivateContract,
    terminateContract,
} from "./actions";

const initialState: ContractState = { status: "idle" };

/**
 * Kündigen ist die zentrale Aktion am Vertrag. Vorgeschlagen wird der nach
 * § 8 frühestmögliche Termin; das Feld bleibt änderbar, weil die Parteien ein
 * früheres Vertragsende jederzeit vereinbaren können.
 */
export function TerminateAction({
    contractId,
    earliestDate,
}: {
    contractId: string;
    /** Frühestmöglicher Termin als `yyyy-mm-dd`, auf dem Server gerechnet. */
    earliestDate: string;
}) {
    const dateId = useId();

    return (
        <ConfirmAction
            action={terminateContract}
            initialState={initialState}
            fields={{ contractId }}
            label="Kündigen"
            title="Vertrag kündigen"
            description="Zum Ende der Grundlaufzeit, wenn die Kündigung einen Monat vorher zugeht, sonst einen Monat nach heute (§ 8 AGB)."
            confirmLabel="Kündigen"
            variant="outline"
        >
            <div className="space-y-3">
                <Label htmlFor={dateId}>Vertragsende</Label>
                <Input
                    id={dateId}
                    name="terminatedTo"
                    type="date"
                    defaultValue={earliestDate}
                    required
                />
                <p className="text-xs text-muted-foreground">
                    Vorgeschlagen ist der frühestmögliche Termin. Ein früheres
                    Datum ist möglich, wenn es so vereinbart wurde.
                </p>
            </div>

            <label className="flex items-start gap-3 text-sm leading-6">
                <input
                    type="checkbox"
                    name="notify"
                    defaultChecked
                    className="mt-1.5 size-4 accent-foreground"
                />
                Kündigungsbestätigung senden
            </label>
            <p className="text-xs text-muted-foreground">
                § 8 (4) AGB schuldet dem Kunden die Bestätigung in Textform mit
                dem Vertragsende.
            </p>
        </ConfirmAction>
    );
}

export function ReactivateAction({ contractId }: { contractId: string }) {
    return (
        <ConfirmAction
            action={reactivateContract}
            initialState={initialState}
            fields={{ contractId }}
            label="Kündigung zurücknehmen"
            title="Kündigung zurücknehmen"
            description="Der Vertrag läuft wieder unbefristet weiter und das Vertragsende wird entfernt. Der Kunde wird darüber nicht automatisch informiert."
            confirmLabel="Zurücknehmen"
            variant="outline"
        />
    );
}

export function DeleteAction({ contractId }: { contractId: string }) {
    return (
        <ConfirmAction
            action={deleteContract}
            initialState={initialState}
            fields={{ contractId }}
            label="Löschen"
            title="Vertrag löschen"
            description="Der Vertrag wird endgültig entfernt. Das ist nur möglich, solange keine Rechnung und kein Angebot auf ihn verweisen."
            confirmLabel="Löschen"
            confirmVariant="destructive"
        />
    );
}
