"use client";

import { useActionState, useState } from "react";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TicketPriority, TicketStatus } from "@/db/schema";
import {
    mergeAction,
    noteAction,
    replyAction,
    type TicketActionState,
    unmergeAction,
    updateAction,
} from "../actions";

const INITIAL: TicketActionState = { status: "idle" };

export default function TicketForms({
    ticketId,
    status,
    priority,
    assigneeId,
    customerId,
    customerName,
    merged,
    staff,
    departments,
    cannedReplies,
    mergeTargets,
}: {
    ticketId: string;
    status: TicketStatus;
    priority: TicketPriority;
    assigneeId: string | null;
    customerId: string | null;
    customerName: string | null;
    merged: boolean;
    staff: { id: string; name: string }[];
    departments: { id: string; name: string }[];
    cannedReplies: { id: string; title: string; body: string }[];
    mergeTargets: { id: string; label: string }[];
}) {
    const [replyState, reply, replying] = useActionState(replyAction, INITIAL);
    const [noteState, note, noting] = useActionState(noteAction, INITIAL);
    const [updateState, update, updating] = useActionState(
        updateAction,
        INITIAL,
    );
    const [mergeState, merge, merging] = useActionState(mergeAction, INITIAL);
    const [unmergeState, unmerge, unmerging] = useActionState(
        unmergeAction,
        INITIAL,
    );

    /**
     * Controlled, deliberately. React resets an uncontrolled form once a
     * `useActionState` action settles, and a canned reply dropped in before
     * the send would be wiped by the previous action's result — the same
     * trap the Tarifwechsel form fell into in Phase 6.
     */
    const [body, setBody] = useState("");

    return (
        <aside className="space-y-8">
            {!merged ? (
                <section className="space-y-3 rounded-lg border p-4">
                    <h2 className="text-sm font-medium">Antworten</h2>
                    <p className="text-xs text-muted-foreground">
                        Geht an die Adressen, die dieses Ticket kennt — den
                        Absender und die Kontakte des Kontos. Nicht an jemanden,
                        der nur die Nummer im Betreff kannte.
                    </p>

                    {cannedReplies.length > 0 ? (
                        <select
                            aria-label="Textbaustein"
                            defaultValue=""
                            onChange={(event) => {
                                const found = cannedReplies.find(
                                    (entry) => entry.id === event.target.value,
                                );

                                if (found) {
                                    setBody((current) =>
                                        current
                                            ? `${current}\n\n${found.body}`
                                            : found.body,
                                    );
                                }

                                event.target.value = "";
                            }}
                            className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                        >
                            <option value="">Textbaustein einfügen…</option>
                            {cannedReplies.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                    {entry.title}
                                </option>
                            ))}
                        </select>
                    ) : null}

                    <form action={reply} className="space-y-3">
                        <input type="hidden" name="ticketId" value={ticketId} />
                        <Textarea
                            name="body"
                            rows={8}
                            required
                            value={body}
                            onChange={(event) => setBody(event.target.value)}
                            placeholder="Antwort an den Kunden"
                        />
                        <div className="space-y-2">
                            <Label htmlFor="cc">CC (optional)</Label>
                            <Input
                                id="cc"
                                name="cc"
                                placeholder="weitere@example.net"
                            />
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input type="checkbox" name="close" />
                            Ticket mit dieser Antwort schließen
                        </label>
                        <Button type="submit" disabled={replying}>
                            {replying ? "Sende…" : "Senden"}
                        </Button>
                        <FormStatus
                            tone={
                                replyState.status === "error"
                                    ? "error"
                                    : "success"
                            }
                            message={replyState.message}
                            variant="inline"
                        />
                    </form>
                </section>
            ) : null}

            <section className="space-y-3 rounded-lg border p-4">
                <h2 className="text-sm font-medium">Interne Notiz</h2>
                <p className="text-xs text-muted-foreground">
                    Verlässt das Haus nie — weder per Mail noch über die
                    Schnittstelle, auch nicht für einen Verwaltungsschlüssel.
                </p>
                <form action={note} className="space-y-3">
                    <input type="hidden" name="ticketId" value={ticketId} />
                    <Textarea name="body" rows={4} required />
                    <Button type="submit" variant="outline" disabled={noting}>
                        {noting ? "Speichere…" : "Notiz speichern"}
                    </Button>
                    <FormStatus
                        tone={
                            noteState.status === "error" ? "error" : "success"
                        }
                        message={noteState.message}
                        variant="inline"
                    />
                </form>
            </section>

            <section className="space-y-3 rounded-lg border p-4">
                <h2 className="text-sm font-medium">Vorgang</h2>
                <form action={update} className="space-y-4">
                    <input type="hidden" name="ticketId" value={ticketId} />
                    <SelectField
                        id="status"
                        label="Status"
                        defaultValue={status}
                        options={[
                            { value: "open", label: "Offen" },
                            { value: "waiting", label: "Wartet auf Kunden" },
                            { value: "on_hold", label: "Zurückgestellt" },
                            { value: "closed", label: "Geschlossen" },
                        ]}
                    />
                    <SelectField
                        id="priority"
                        label="Dringlichkeit"
                        defaultValue={priority}
                        options={[
                            { value: "low", label: "Niedrig" },
                            { value: "normal", label: "Normal" },
                            { value: "high", label: "Hoch" },
                            { value: "urgent", label: "Dringend" },
                        ]}
                    />
                    <SelectField
                        id="assigneeId"
                        label="Zuständig"
                        defaultValue={assigneeId ?? ""}
                        options={[
                            { value: "", label: "Niemand" },
                            ...staff.map((entry) => ({
                                value: entry.id,
                                label: entry.name,
                            })),
                        ]}
                    />
                    <div className="space-y-2">
                        <Label htmlFor="customerId">Kundenkonto</Label>
                        <Input
                            id="customerId"
                            name="customerId"
                            defaultValue={customerId ?? ""}
                            placeholder="customer_…"
                        />
                        <p className="text-xs text-muted-foreground">
                            {customerName
                                ? `Zurzeit: ${customerName}.`
                                : "Zurzeit keinem Konto zugeordnet — das Ticket ist nur hier sichtbar."}
                        </p>
                    </div>
                    <Button type="submit" variant="outline" disabled={updating}>
                        {updating ? "Speichere…" : "Speichern"}
                    </Button>
                    <FormStatus
                        tone={
                            updateState.status === "error" ? "error" : "success"
                        }
                        message={updateState.message}
                        variant="inline"
                    />
                </form>
            </section>

            {merged ? (
                <section className="space-y-3 rounded-lg border p-4">
                    <h2 className="text-sm font-medium">Trennen</h2>
                    <p className="text-xs text-muted-foreground">
                        Holt genau die Nachrichten zurück, die bei der
                        Zusammenführung von hier gegangen sind — und nichts, was
                        inzwischen beim Ziel angekommen ist.
                    </p>
                    <form action={unmerge}>
                        <input type="hidden" name="ticketId" value={ticketId} />
                        <Button
                            type="submit"
                            variant="outline"
                            disabled={unmerging}
                        >
                            {unmerging ? "Trenne…" : "Wieder trennen"}
                        </Button>
                        <FormStatus
                            tone={
                                unmergeState.status === "error"
                                    ? "error"
                                    : "success"
                            }
                            message={unmergeState.message}
                            variant="inline"
                        />
                    </form>
                </section>
            ) : mergeTargets.length > 0 ? (
                <section className="space-y-3 rounded-lg border p-4">
                    <h2 className="text-sm font-medium">Zusammenführen</h2>
                    <p className="text-xs text-muted-foreground">
                        Dieses Ticket geht in ein anderes auf. Seine Nummer
                        bleibt gültig und führt von da an dorthin.
                    </p>
                    <form action={merge} className="space-y-3">
                        <input type="hidden" name="ticketId" value={ticketId} />
                        <SelectField
                            id="targetId"
                            label="Ziel-Ticket"
                            required
                            placeholder="Auswählen…"
                            options={mergeTargets.map((entry) => ({
                                value: entry.id,
                                label: entry.label,
                            }))}
                        />
                        <Button
                            type="submit"
                            variant="outline"
                            disabled={merging}
                        >
                            {merging ? "Führe zusammen…" : "Zusammenführen"}
                        </Button>
                        <FormStatus
                            tone={
                                mergeState.status === "error"
                                    ? "error"
                                    : "success"
                            }
                            message={mergeState.message}
                            variant="inline"
                        />
                    </form>
                </section>
            ) : null}

            {departments.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    Es ist keine Abteilung eingerichtet.
                </p>
            ) : null}
        </aside>
    );
}
