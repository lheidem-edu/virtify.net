"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import FormStatus from "@/lib/components/account/form-status";
import { type SettingsState, saveSettings } from "./actions";

const initialState: SettingsState = { status: "idle" };

function Field({
    id,
    label,
    defaultValue,
    help,
    type = "text",
}: {
    id: string;
    label: string;
    defaultValue: string | number;
    help?: string;
    type?: string;
}) {
    return (
        <div className="space-y-3">
            <Label htmlFor={id}>{label}</Label>
            <Input id={id} name={id} defaultValue={defaultValue} type={type} />
            {help ? (
                <p className="text-xs text-muted-foreground">{help}</p>
            ) : null}
        </div>
    );
}

export default function SettingsForm({
    values,
}: {
    values: Record<string, string | number>;
}) {
    const [state, formAction, pending] = useActionState(
        saveSettings,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-10">
            {state.status === "saved" ? (
                <FormStatus tone="success" message={state.message} />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="space-y-6">
                <h3 className="text-sm font-medium tracking-tight">Website</h3>
                <div className="grid gap-6 sm:grid-cols-2">
                    <Field
                        id="siteName"
                        label="Name"
                        defaultValue={values.siteName}
                        help="Steht im Wortzeichen, in den Dokumenten und in jeder Mail."
                    />
                    <Field
                        id="siteUrl"
                        label="Adresse"
                        defaultValue={values.siteUrl}
                        help="Mit https://. Links in Mails werden daraus gebaut."
                    />
                </div>
                <Field
                    id="tagline"
                    label="Zeile unter dem Wortzeichen"
                    defaultValue={values.tagline}
                />
                <div className="space-y-3">
                    <Label htmlFor="description">Beschreibung</Label>
                    <Textarea
                        id="description"
                        name="description"
                        rows={2}
                        defaultValue={String(values.description)}
                    />
                    <p className="text-xs text-muted-foreground">
                        Für Suchmaschinen und beim Teilen eines Links.
                    </p>
                </div>
            </div>

            <div className="space-y-6">
                <h3 className="text-sm font-medium tracking-tight">Anbieter</h3>
                <div className="grid gap-6 sm:grid-cols-2">
                    <Field
                        id="operatorName"
                        label="Name"
                        defaultValue={values.operatorName}
                    />
                    <Field
                        id="operatorStreet"
                        label="Straße und Hausnummer"
                        defaultValue={values.operatorStreet}
                    />
                    <Field
                        id="operatorCity"
                        label="PLZ und Ort"
                        defaultValue={values.operatorCity}
                        help="In einem Feld, so wie es auf dem Brief steht."
                    />
                    <Field
                        id="operatorCountry"
                        label="Land"
                        defaultValue={values.operatorCountry}
                    />
                    <Field
                        id="operatorEmail"
                        label="E-Mail"
                        defaultValue={values.operatorEmail}
                        help="Absender jeder Mail und Kontaktstelle im Impressum."
                        type="email"
                    />
                    <Field
                        id="operatorPhone"
                        label="Telefon"
                        defaultValue={values.operatorPhone}
                        help="Nur auf Rechnungen und Angeboten, nicht im Impressum."
                    />
                </div>
                <Field
                    id="operatorVatId"
                    label="USt-IdNr."
                    defaultValue={values.operatorVatId}
                    help="Steht im Impressum und in der XRechnung."
                />
            </div>

            <div className="space-y-6">
                <h3 className="text-sm font-medium tracking-tight">
                    Bankverbindung
                </h3>
                <div className="grid gap-6 sm:grid-cols-2">
                    <Field
                        id="bankName"
                        label="Bank"
                        defaultValue={values.bankName}
                    />
                    <Field
                        id="bankBic"
                        label="BIC"
                        defaultValue={values.bankBic}
                    />
                </div>
                <Field
                    id="bankIban"
                    label="IBAN"
                    defaultValue={values.bankIban}
                    help="Steht im Fuß jeder Rechnung."
                />
            </div>

            <div className="space-y-6">
                <h3 className="text-sm font-medium tracking-tight">Fristen</h3>
                <p className="max-w-xl text-xs leading-6 text-muted-foreground">
                    Diese Zahlen stehen in den AGB und in der
                    Datenschutzerklärung, überall dort als Platzhalter. Änderst
                    du eine hier, ändert sich der Text mit — für Verträge, die
                    schon laufen, gilt aber die Fassung, die bei Vertragsschluss
                    galt.
                </p>
                <div className="grid gap-6 sm:grid-cols-2">
                    <Field
                        id="paymentTermDays"
                        label="Zahlungsziel in Tagen"
                        defaultValue={values.paymentTermDays}
                        type="number"
                        help="Bestimmt auch das Fälligkeitsdatum neuer Rechnungen."
                    />
                    <Field
                        id="logRetentionDays"
                        label="Aufbewahrung der Logdateien in Tagen"
                        defaultValue={values.logRetentionDays}
                        type="number"
                    />
                    <Field
                        id="dataRetrievalDays"
                        label="Datenabruf nach Vertragsende in Tagen"
                        defaultValue={values.dataRetrievalDays}
                        type="number"
                    />
                    <Field
                        id="securityMaintenanceNoticeHours"
                        label="Vorlauf für Sicherheitswartung in Stunden"
                        defaultValue={values.securityMaintenanceNoticeHours}
                        type="number"
                    />
                </div>
            </div>

            <Button type="submit" size="lg" disabled={pending}>
                {pending ? "…" : "Speichern"}
            </Button>
        </form>
    );
}
