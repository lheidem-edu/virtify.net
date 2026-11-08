"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type MailSettingsState, saveMailChannelAction } from "./actions";

const INITIAL: MailSettingsState = { status: "idle" };

function Secret({
    name,
    label,
    present,
    help,
}: {
    name: string;
    label: string;
    present: boolean;
    help?: string;
}) {
    return (
        <div className="space-y-2">
            <Label htmlFor={name}>{label}</Label>
            <Input
                id={name}
                name={name}
                type="password"
                autoComplete="off"
                placeholder={
                    present
                        ? "gespeichert — leer lassen, um ihn zu behalten"
                        : "nicht gesetzt"
                }
            />
            {help ? (
                <p className="text-xs text-muted-foreground">{help}</p>
            ) : null}
        </div>
    );
}

export default function ChannelForm({
    enabled,
    source,
    hasTenant,
    hasClientId,
    hasSecret,
    processedFolder,
    maxAttachmentMb,
    autoReplyPerHour,
    outboundSender,
    transport,
}: {
    enabled: boolean;
    source: "database" | "environment";
    hasTenant: boolean;
    hasClientId: boolean;
    hasSecret: boolean;
    processedFolder: string;
    maxAttachmentMb: number;
    autoReplyPerHour: number;
    outboundSender: string | null;
    transport: "smtp" | "graph";
}) {
    const [state, action, pending] = useActionState(
        saveMailChannelAction,
        INITIAL,
    );

    return (
        <form action={action} className="max-w-2xl space-y-5">
            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={enabled}
                />
                Kanal aktiv
            </label>

            <Secret
                name="tenantId"
                label="Verzeichnis-ID (Tenant)"
                present={hasTenant}
            />
            <Secret
                name="clientId"
                label="Anwendungs-ID (Client)"
                present={hasClientId}
            />
            <Secret
                name="clientSecret"
                label="Clientgeheimnis"
                present={hasSecret}
                help="Zertifikatsanmeldung ist der bessere Weg und in docs/m365-setup.md beschrieben; implementiert ist bisher nur das Geheimnis."
            />

            <div className="space-y-2">
                <Label htmlFor="processedFolder">Ordner für Erledigtes</Label>
                <Input
                    id="processedFolder"
                    name="processedFolder"
                    defaultValue={processedFolder}
                />
                <p className="text-xs text-muted-foreground">
                    Wird angelegt, falls es ihn nicht gibt.
                </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor="maxAttachmentMb">Anhänge bis (MB)</Label>
                    <Input
                        id="maxAttachmentMb"
                        name="maxAttachmentMb"
                        defaultValue={maxAttachmentMb}
                        inputMode="numeric"
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="autoReplyPerHour">
                        Automatische Antworten je Absender und Stunde
                    </Label>
                    <Input
                        id="autoReplyPerHour"
                        name="autoReplyPerHour"
                        defaultValue={autoReplyPerHour}
                        inputMode="numeric"
                    />
                    <p className="text-xs text-muted-foreground">
                        0 schaltet die Eingangsbestätigung ab.
                    </p>
                </div>
            </div>

            <div className="space-y-2">
                <Label htmlFor="outboundSender">
                    Absenderpostfach für Systemmails
                </Label>
                <Input
                    id="outboundSender"
                    name="outboundSender"
                    defaultValue={outboundSender ?? ""}
                    placeholder="rechnung@example.net"
                />
            </div>

            <SelectField
                id="transport"
                label="Systemmails versenden über"
                defaultValue={transport}
                options={[
                    { value: "smtp", label: "SMTP-Relay (wie bisher)" },
                    { value: "graph", label: "Microsoft Graph" },
                ]}
                help="Ohne Absenderpostfach oder ohne eingerichteten Kanal fällt der Versand auf SMTP zurück, statt die Mail zu verwerfen."
            />

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" name="clear" />
                Gespeicherte Zugangsdaten löschen und wieder die Umgebung
                verwenden
            </label>

            <p className="text-xs text-muted-foreground">
                Zugangsdaten kommen zurzeit aus{" "}
                {source === "database" ? "der Datenbank" : "der Umgebung"}.
            </p>

            <Button type="submit" disabled={pending}>
                {pending ? "Speichere…" : "Speichern"}
            </Button>

            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
            />
        </form>
    );
}
