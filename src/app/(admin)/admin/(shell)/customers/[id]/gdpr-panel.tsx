"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { anonymize, auditedExport, type GdprState } from "./gdpr-actions";

/**
 * The DSGVO panel on a customer.
 *
 * Two buttons with very different weights, and the page says so. The export
 * is a read that leaves a trace; the anonymisation is the only irreversible
 * thing in the admin area, so it asks for the customer number to be typed out
 * rather than offering a checkbox.
 */

export function ExportPanel({
    customerId,
    exportHref,
}: {
    customerId: string;
    exportHref: string;
}) {
    const [state, formAction, pending] = useActionState<GdprState, FormData>(
        auditedExport,
        { status: "idle" },
    );

    return (
        <div className="space-y-3 rounded-lg border p-6">
            <h3 className="text-sm font-medium">Datenauskunft</h3>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Alles, was zu diesem Konto gespeichert ist, als JSON-Datei plus
                jeden Beleg als PDF. Interne Notizen und Mitarbeiter-Vermerke
                sind nicht enthalten (Art. 15 Abs. 4 DSGVO), Passwörter und
                Zugangsdaten ebenfalls nicht. Jede Auskunft wird protokolliert.
            </p>

            <div className="flex flex-wrap items-center gap-3">
                <form action={formAction}>
                    <input type="hidden" name="customerId" value={customerId} />
                    <Button
                        type="submit"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                    >
                        {pending ? "Wird erzeugt…" : "Auskunft protokollieren"}
                    </Button>
                </form>

                <a
                    href={exportHref}
                    className="rounded-md border px-3 py-1.5 text-xs transition-colors hover:border-ring"
                >
                    Archiv herunterladen
                </a>
            </div>

            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </div>
    );
}

export function AnonymizePanel({
    customerId,
    customerNumber,
    blockers,
}: {
    customerId: string;
    customerNumber: number;
    blockers: string[];
}) {
    const [state, formAction, pending] = useActionState<GdprState, FormData>(
        anonymize,
        { status: "idle" },
    );

    return (
        <div className="space-y-3 rounded-lg border border-amber-500/40 p-6">
            <h3 className="text-sm font-medium">Anonymisieren</h3>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Ersetzt Name, Anschrift, Telefonnummer, USt-IdNr. und alle
                E-Mail-Adressen, löscht Passwörter, Sitzungen und
                Zwei-Faktor-Geheimnisse und widerruft die API-Schlüssel. Das
                Konto wird geschlossen.
            </p>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                <strong className="font-medium text-foreground">
                    Was bleibt:
                </strong>{" "}
                Rechnungen, Korrekturen und ihre PDF-Dateien samt der darauf
                eingefrorenen Käuferangaben — § 14 Abs. 4 UStG verlangt sie auf
                dem Dokument, § 147 AO und § 14b UStG verlangen das Dokument
                zehn Jahre lang, und Art. 17 Abs. 3 lit. b DSGVO nimmt genau das
                aus. Tickets bleiben als Handelsbriefe (§ 257 HGB) erhalten,
                ihre Absenderadresse wird jedoch ersetzt. Das Protokoll bleibt
                vollständig — auch der Eintrag über diese Anonymisierung.
            </p>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Das lässt sich nicht rückgängig machen.
            </p>

            {blockers.length > 0 ? (
                <div className="space-y-1 rounded-md border px-4 py-3 text-sm">
                    <p>Noch nicht möglich:</p>
                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                        {blockers.map((blocker) => (
                            <li key={blocker}>{blocker}</li>
                        ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                        Ein Konto, das noch abgerechnet wird, kann nicht
                        anonymisiert werden: die nächste Verlängerung würde eine
                        Rechnung an „Anonymisiert“ stellen und das Mahnwesen
                        würde einer Adresse hinterherlaufen, die es nicht mehr
                        gibt.
                    </p>
                </div>
            ) : (
                <form action={formAction} className="space-y-3">
                    <input type="hidden" name="customerId" value={customerId} />
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <label className="flex flex-col gap-1 text-xs">
                            <span className="text-muted-foreground">
                                Zur Bestätigung die Kundennummer „
                                {customerNumber}“ eintragen
                            </span>
                            <input
                                name="confirm"
                                required
                                autoComplete="off"
                                className="h-8 w-40 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:border-ring"
                            />
                        </label>
                        <label className="flex flex-1 flex-col gap-1 text-xs">
                            <span className="text-muted-foreground">
                                Grund (optional, fürs Protokoll)
                            </span>
                            <input
                                name="reason"
                                autoComplete="off"
                                className="h-8 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:border-ring"
                            />
                        </label>
                        <Button
                            type="submit"
                            variant="outline"
                            size="sm"
                            disabled={pending}
                        >
                            {pending ? "Läuft…" : "Anonymisieren"}
                        </Button>
                    </div>
                </form>
            )}

            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </div>
    );
}
