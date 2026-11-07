"use client";

import ConfirmAction from "@/components/shared/confirm-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    cancelTaxSwitch,
    scheduleTaxSwitch,
    type TaxModeState,
} from "./actions";

const initialState: TaxModeState = { status: "idle" };

export type StrategyOption = {
    id: string;
    label: string;
    description: string;
};

/**
 * Scheduling a switch is behind a confirmation *and* a tick box, because the
 * consequence is invisible until it has happened: from the chosen day on,
 * every invoice that is finalized carries a different tax, and no invoice
 * finalized before it ever changes.
 */
export function TaxSwitchForm({
    strategies,
    current,
    today,
}: {
    strategies: StrategyOption[];
    current: string;
    today: string;
}) {
    return (
        <ConfirmAction
            action={scheduleTaxSwitch}
            initialState={initialState}
            fields={{}}
            label="Umstellung planen"
            title="Besteuerung umstellen?"
            description="Die Umstellung gilt ab dem Stichtag und nie rückwirkend: jede Rechnung, die ab diesem Tag ausgestellt wird, trägt die neue Besteuerung; alles, was vorher ausgestellt wurde, bleibt unverändert. Bereits ausgestellte Rechnungen werden nicht angefasst."
            confirmLabel="Umstellung planen"
            confirmVariant="destructive"
        >
            <div className="space-y-2">
                <Label htmlFor="strategy">Neue Besteuerung</Label>
                <select
                    id="strategy"
                    name="strategy"
                    defaultValue={
                        strategies.find((entry) => entry.id !== current)?.id ??
                        current
                    }
                    className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                >
                    {strategies.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.label}
                        </option>
                    ))}
                </select>
                <p className="text-muted-foreground text-xs">
                    {strategies.find((entry) => entry.id !== current)
                        ?.description ?? ""}
                </p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="effectiveFrom">Stichtag</Label>
                <Input
                    id="effectiveFrom"
                    name="effectiveFrom"
                    type="date"
                    defaultValue={today}
                    min={today}
                />
                <p className="text-muted-foreground text-xs">
                    Gilt ab 00:00 Uhr dieses Tages, Zeitzone Europe/Berlin.
                </p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="note">Notiz</Label>
                <Input
                    id="note"
                    name="note"
                    placeholder="z. B. Grenze nach § 19 überschritten, Abstimmung mit der Steuerberatung"
                />
            </div>

            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    name="understood"
                    value="yes"
                    className="mt-1"
                />
                <span>
                    Mir ist klar, dass ab dem Stichtag jede neu ausgestellte
                    Rechnung die neue Besteuerung trägt und dass das mit der
                    Steuerberatung abgestimmt sein sollte.
                </span>
            </label>
        </ConfirmAction>
    );
}

export function CancelTaxSwitchForm({
    id,
    label,
}: {
    id: string;
    label: string;
}) {
    return (
        <ConfirmAction
            action={cancelTaxSwitch}
            initialState={initialState}
            fields={{ id }}
            label="Zurücknehmen"
            title="Geplante Umstellung zurücknehmen?"
            description={`Die geplante Umstellung auf ${label} wird gelöscht. Wirksam gewordene Umstellungen bleiben, weil unter ihnen Rechnungen ausgestellt wurden.`}
            confirmLabel="Zurücknehmen"
            variant="outline"
        />
    );
}
