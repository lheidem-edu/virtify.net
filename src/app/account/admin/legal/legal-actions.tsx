"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import ConfirmAction from "@/lib/components/account/confirm-action";
import FormStatus from "@/lib/components/account/form-status";
import SelectField from "@/lib/components/account/select-field";
import {
    addSection,
    announceDocument,
    createDraft,
    deleteSection,
    discardDraft,
    type LegalState,
    moveSection,
    publishDocument,
    saveDocument,
    saveSection,
} from "./actions";

const initialState: LegalState = { status: "idle" };

export function CreateDraftForm({ kind }: { kind: string }) {
    const [state, formAction, pending] = useActionState(
        createDraft,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="kind" value={kind} />
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
                {pending ? "…" : "Neue Fassung anlegen"}
            </Button>
        </form>
    );
}

export function DocumentForm({
    documentId,
    title,
    eyebrow,
    intro,
}: {
    documentId: string;
    title: string;
    eyebrow: string;
    intro: string;
}) {
    const [state, formAction, pending] = useActionState(
        saveDocument,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-6">
            <input type="hidden" name="documentId" value={documentId} />

            {state.status === "saved" ? (
                <FormStatus tone="success" message={state.message} />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="title">Titel</Label>
                    <Input id="title" name="title" defaultValue={title} />
                </div>
                <div className="space-y-3">
                    <Label htmlFor="eyebrow">Überzeile</Label>
                    <Input
                        id="eyebrow"
                        name="eyebrow"
                        defaultValue={eyebrow}
                        placeholder="Rechtliches"
                    />
                </div>
            </div>

            <div className="space-y-3">
                <Label htmlFor="intro">Einleitung</Label>
                <Textarea
                    id="intro"
                    name="intro"
                    rows={5}
                    defaultValue={intro}
                />
                <p className="text-xs text-muted-foreground">
                    Steht über den Abschnitten. Eine Leerzeile trennt zwei
                    Absätze.
                </p>
            </div>

            <Button type="submit" size="lg" disabled={pending}>
                {pending ? "…" : "Kopf speichern"}
            </Button>
        </form>
    );
}

export function SectionForm({
    sectionId,
    label,
    title,
    variant,
    items,
    first,
    last,
}: {
    sectionId: string;
    label: string;
    title: string;
    variant: string;
    items: string;
    first: boolean;
    last: boolean;
}) {
    const [state, formAction, pending] = useActionState(
        saveSection,
        initialState,
    );

    return (
        <div className="space-y-4 rounded-lg border p-6">
            <form action={formAction} className="space-y-6">
                <input type="hidden" name="sectionId" value={sectionId} />

                {state.status === "saved" ? (
                    <FormStatus tone="success" message={state.message} />
                ) : null}
                {state.status === "error" ? (
                    <FormStatus tone="error" message={state.message} />
                ) : null}

                <div className="grid gap-6 sm:grid-cols-[8rem_minmax(0,1fr)_10rem]">
                    <div className="space-y-3">
                        <Label htmlFor={`label-${sectionId}`}>Nummer</Label>
                        <Input
                            id={`label-${sectionId}`}
                            name="label"
                            defaultValue={label}
                            placeholder="§ 7"
                        />
                    </div>
                    <div className="space-y-3">
                        <Label htmlFor={`title-${sectionId}`}>
                            Überschrift
                        </Label>
                        <Input
                            id={`title-${sectionId}`}
                            name="title"
                            defaultValue={title}
                        />
                    </div>
                    <SelectField
                        id={`variant-${sectionId}`}
                        name="variant"
                        label="Darstellung"
                        defaultValue={variant}
                        options={[
                            { value: "paren", label: "(1) (2) (3)" },
                            { value: "dash", label: "Aufzählung" },
                            { value: "prose", label: "Absätze" },
                        ]}
                    />
                </div>

                <div className="space-y-3">
                    <Label htmlFor={`items-${sectionId}`}>Text</Label>
                    <Textarea
                        id={`items-${sectionId}`}
                        name="items"
                        rows={Math.min(
                            24,
                            Math.max(6, items.split("\n").length + 1),
                        )}
                        defaultValue={items}
                        className="font-mono text-xs"
                    />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" size="sm" disabled={pending}>
                        {pending ? "…" : "Abschnitt speichern"}
                    </Button>
                </div>
            </form>

            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                <MoveButton
                    sectionId={sectionId}
                    direction="up"
                    disabled={first}
                />
                <MoveButton
                    sectionId={sectionId}
                    direction="down"
                    disabled={last}
                />
                <ConfirmAction
                    action={deleteSection}
                    initialState={initialState}
                    fields={{ sectionId }}
                    label="Abschnitt löschen"
                    title="Abschnitt löschen?"
                    description="Der Abschnitt verschwindet aus diesem Entwurf. Bereits in Kraft gesetzte Fassungen bleiben unberührt."
                    confirmLabel="Löschen"
                    confirmVariant="destructive"
                />
            </div>
        </div>
    );
}

function MoveButton({
    sectionId,
    direction,
    disabled,
}: {
    sectionId: string;
    direction: "up" | "down";
    disabled: boolean;
}) {
    const [, formAction, pending] = useActionState(moveSection, initialState);

    return (
        <form action={formAction}>
            <input type="hidden" name="sectionId" value={sectionId} />
            <input type="hidden" name="direction" value={direction} />
            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={disabled || pending}
            >
                {direction === "up" ? "Nach oben" : "Nach unten"}
            </Button>
        </form>
    );
}

export function AddSectionForm({ documentId }: { documentId: string }) {
    const [, formAction, pending] = useActionState(addSection, initialState);

    return (
        <form action={formAction}>
            <input type="hidden" name="documentId" value={documentId} />
            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
            >
                {pending ? "…" : "Abschnitt hinzufügen"}
            </Button>
        </form>
    );
}

export function PublishForm({
    documentId,
    suggested,
}: {
    documentId: string;
    suggested: string;
}) {
    const [state, formAction, pending] = useActionState(
        publishDocument,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-md space-y-4">
            <input type="hidden" name="documentId" value={documentId} />

            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="space-y-3">
                <Label htmlFor="effectiveFrom">Gilt ab</Label>
                <Input
                    id="effectiveFrom"
                    name="effectiveFrom"
                    type="date"
                    defaultValue={suggested}
                />
                <p className="text-xs leading-6 text-muted-foreground">
                    Vorgeschlagen sind sechs Wochen — die Frist, die § 17 der
                    AGB für eine Änderung zusagt. Bis zu diesem Tag bleibt die
                    bisherige Fassung in Kraft.
                </p>
            </div>

            <Button type="submit" size="lg" disabled={pending}>
                {pending ? "…" : "In Kraft setzen"}
            </Button>
        </form>
    );
}

export function DiscardDraftAction({ documentId }: { documentId: string }) {
    return (
        <ConfirmAction
            action={discardDraft}
            initialState={initialState}
            fields={{ documentId }}
            label="Entwurf verwerfen"
            title="Entwurf verwerfen?"
            description="Der Entwurf und alle Änderungen daran gehen verloren. Die geltende Fassung bleibt, wie sie ist."
            confirmLabel="Verwerfen"
            confirmVariant="destructive"
        />
    );
}

export function AnnounceAction({
    documentId,
    label,
    effective,
}: {
    documentId: string;
    label: string;
    effective: string;
}) {
    return (
        <ConfirmAction
            action={announceDocument}
            initialState={initialState}
            fields={{ documentId }}
            label="Kunden benachrichtigen"
            title={`${label} mitteilen?`}
            description={`Jedes Konto mit einem laufenden Vertrag bekommt eine E-Mail: die neue Fassung gilt ab dem ${effective}, und wer nicht innerhalb von sechs Wochen widerspricht, stimmt zu. Das lässt sich nicht zurücknehmen.`}
            confirmLabel="Mitteilung senden"
            variant="outline"
        />
    );
}
