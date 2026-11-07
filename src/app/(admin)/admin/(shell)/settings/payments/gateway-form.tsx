"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type GatewaySettingsState, saveGatewaySettings } from "./actions";

const initialState: GatewaySettingsState = { status: "idle" };

export type SecretField = {
    name: string;
    label: string;
    /** Whether something is stored for it. Never the value itself. */
    present: boolean;
    help?: string;
};

/**
 * One gateway's settings.
 *
 * The secrets are write-only. What the server sends is whether something is
 * stored, never what — they are encrypted at rest and there is no reason for
 * a browser to ever hold them. An empty field therefore leaves what is stored
 * alone; clearing is its own, explicit choice.
 */
export default function GatewayForm({
    id,
    label,
    enabled,
    mode,
    source,
    secrets,
    paypalRecurringMode,
    showMode = true,
}: {
    id: string;
    label: string;
    enabled: boolean;
    mode: "sandbox" | "live";
    source: "database" | "environment";
    secrets: SecretField[];
    paypalRecurringMode?: "vault" | "subscriptions";
    showMode?: boolean;
}) {
    const [state, formAction, pending] = useActionState(
        saveGatewaySettings,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-xl space-y-5">
            <input type="hidden" name="gateway" value={id} />

            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="page"
                />
            ) : null}
            {state.status === "saved" ? (
                <FormStatus
                    tone="success"
                    message={state.message}
                    variant="page"
                />
            ) : null}

            <div className="flex items-center gap-3">
                <input
                    id={`enabled-${id}`}
                    type="checkbox"
                    name="enabled"
                    defaultChecked={enabled}
                    className="size-4 rounded border"
                />
                <Label htmlFor={`enabled-${id}`}>
                    {label} im Kundenbereich anbieten
                </Label>
            </div>

            {showMode ? (
                <SelectField
                    id={`mode-${id}`}
                    name="mode"
                    label="Umgebung"
                    defaultValue={mode}
                    options={[
                        { value: "sandbox", label: "Sandbox (Testbetrieb)" },
                        { value: "live", label: "Live (echtes Geld)" },
                    ]}
                    help="Live heißt, dass Kunden tatsächlich belastet werden."
                />
            ) : null}

            {paypalRecurringMode ? (
                <SelectField
                    id={`recurring-${id}`}
                    name="paypalRecurringMode"
                    label="Wiederkehrende Zahlungen"
                    defaultValue={paypalRecurringMode}
                    options={[
                        {
                            value: "subscriptions",
                            label: "Subscriptions — PayPal führt den Zeitplan",
                        },
                        {
                            value: "vault",
                            label: "Vault — gespeicherte Zahlungsquelle belasten",
                        },
                    ]}
                    help="Vault setzt voraus, dass PayPal für dieses Konto „reference transactions“ freigeschaltet hat. Ohne diese Freigabe scheitert jeder Einzug."
                />
            ) : null}

            {secrets.map((secret) => (
                <div key={secret.name} className="space-y-2">
                    <Label htmlFor={`${id}-${secret.name}`}>
                        {secret.label}
                    </Label>
                    <Input
                        id={`${id}-${secret.name}`}
                        name={secret.name}
                        type="password"
                        autoComplete="off"
                        placeholder={
                            secret.present
                                ? "gespeichert — leer lassen, um ihn zu behalten"
                                : "nicht gesetzt"
                        }
                    />
                    {secret.help ? (
                        <p className="text-muted-foreground text-xs">
                            {secret.help}
                        </p>
                    ) : null}
                </div>
            ))}

            {secrets.length > 0 ? (
                <div className="flex items-center gap-3">
                    <input
                        id={`clear-${id}`}
                        type="checkbox"
                        name="clear"
                        className="size-4 rounded border"
                    />
                    <Label htmlFor={`clear-${id}`}>
                        Gespeicherte Zugangsdaten löschen und wieder die
                        Umgebungsvariablen verwenden
                    </Label>
                </div>
            ) : null}

            <p className="text-muted-foreground text-xs leading-6">
                {source === "database"
                    ? "Die Zugangsdaten liegen verschlüsselt in der Datenbank."
                    : "Es ist nichts gespeichert; verwendet werden die Umgebungsvariablen."}
            </p>

            <Button type="submit" disabled={pending}>
                {pending ? "…" : "Speichern"}
            </Button>
        </form>
    );
}
