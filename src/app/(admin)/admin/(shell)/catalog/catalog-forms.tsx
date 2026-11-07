"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useActionState, useState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    addGroup,
    addProduct,
    type CatalogState,
    removeGroup,
    reorderGroup,
    saveGroup,
} from "./actions";
import { PRODUCT_STATUSES, PRODUCT_TYPES } from "./labels";

const initial: CatalogState = { status: "idle" };

export type GroupFields = {
    id?: string;
    slug: string;
    name: string;
    tagline: string;
    description: string;
    sortOrder: number;
    hidden: boolean;
};

/** Create or edit a group. The same form for both; the id decides which. */
export function GroupForm({
    group,
    submitLabel,
}: {
    group: GroupFields;
    submitLabel: string;
}) {
    const [state, formAction, pending] = useActionState(
        group.id ? saveGroup : addGroup,
        initial,
    );
    const prefix = group.id ?? "new-group";

    return (
        <form action={formAction} className="max-w-3xl space-y-5">
            {group.id ? (
                <input type="hidden" name="groupId" value={group.id} />
            ) : null}

            {state.status === "saved" ? (
                <FormStatus tone="success" message="Gespeichert." />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-name`}>Name</Label>
                    <Input
                        id={`${prefix}-name`}
                        name="name"
                        defaultValue={group.name}
                        required
                        maxLength={200}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-slug`}>Kürzel</Label>
                    <Input
                        id={`${prefix}-slug`}
                        name="slug"
                        defaultValue={group.slug}
                        maxLength={80}
                        placeholder="wird aus dem Namen gebildet"
                    />
                    <p className="text-xs text-muted-foreground">
                        Steht im Shop in der Adresse: /products/
                        <span className="font-mono">kürzel</span>
                    </p>
                </div>
                <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor={`${prefix}-tagline`}>Zeile darunter</Label>
                    <Input
                        id={`${prefix}-tagline`}
                        name="tagline"
                        defaultValue={group.tagline}
                        maxLength={200}
                    />
                </div>
                <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor={`${prefix}-description`}>
                        Beschreibung
                    </Label>
                    <Textarea
                        id={`${prefix}-description`}
                        name="description"
                        defaultValue={group.description}
                        rows={3}
                        maxLength={2000}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-sortOrder`}>Reihenfolge</Label>
                    <Input
                        id={`${prefix}-sortOrder`}
                        name="sortOrder"
                        type="number"
                        min={0}
                        defaultValue={group.sortOrder}
                    />
                </div>
                <label className="flex items-end gap-3 pb-2 text-sm">
                    <input
                        type="checkbox"
                        name="hidden"
                        defaultChecked={group.hidden}
                        className="size-4"
                    />
                    Im Shop ausblenden
                </label>
            </div>

            <Button type="submit" disabled={pending}>
                {pending ? "Speichert …" : submitLabel}
            </Button>
        </form>
    );
}

/** Create-group form behind a toggle, so the page opens on the list. */
export function NewGroup() {
    const [open, setOpen] = useState(false);

    if (!open) {
        return (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Gruppe anlegen
            </Button>
        );
    }

    return (
        <div className="space-y-5 rounded-lg border p-6">
            <GroupForm
                group={{
                    slug: "",
                    name: "",
                    tagline: "",
                    description: "",
                    sortOrder: 0,
                    hidden: false,
                }}
                submitLabel="Gruppe anlegen"
            />
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Abbrechen
            </Button>
        </div>
    );
}

/** One group's row controls: move it, edit it, remove it. */
export function GroupRowActions({
    group,
    first,
    last,
}: {
    group: GroupFields & { id: string };
    first: boolean;
    last: boolean;
}) {
    const [, moveAction, moving] = useActionState(reorderGroup, initial);
    const [open, setOpen] = useState(false);

    return (
        <>
            <div className="flex items-center justify-end gap-1">
                <form action={moveAction} className="contents">
                    <input type="hidden" name="groupId" value={group.id} />
                    <input type="hidden" name="direction" value="up" />
                    <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        disabled={first || moving}
                        aria-label="Nach oben"
                    >
                        <ChevronUp className="size-4" />
                    </Button>
                </form>
                <form action={moveAction} className="contents">
                    <input type="hidden" name="groupId" value={group.id} />
                    <input type="hidden" name="direction" value="down" />
                    <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        disabled={last || moving}
                        aria-label="Nach unten"
                    >
                        <ChevronDown className="size-4" />
                    </Button>
                </form>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpen((value) => !value)}
                >
                    {open ? "Schließen" : "Bearbeiten"}
                </Button>
                <ConfirmAction
                    action={removeGroup}
                    initialState={initial}
                    fields={{ groupId: group.id }}
                    label="Löschen"
                    title="Gruppe löschen?"
                    description={`„${group.name}“ wird entfernt. Das geht nur, solange kein Produkt mehr darin liegt.`}
                    confirmLabel="Löschen"
                    confirmVariant="destructive"
                />
            </div>

            {open ? (
                <div className="mt-4 rounded-lg border p-6">
                    <GroupForm group={group} submitLabel="Speichern" />
                </div>
            ) : null}
        </>
    );
}

/** Create a product. Everything else is edited on the product's own page. */
export function NewProduct({
    groups,
    modules,
}: {
    groups: { value: string; label: string }[];
    modules: { value: string; label: string }[];
}) {
    const [state, formAction, pending] = useActionState(addProduct, initial);
    const [open, setOpen] = useState(false);

    if (!open) {
        return (
            <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(true)}
                disabled={groups.length === 0}
            >
                {groups.length === 0
                    ? "Erst eine Gruppe anlegen"
                    : "Produkt anlegen"}
            </Button>
        );
    }

    return (
        <div className="rounded-lg border p-6">
            <form action={formAction} className="max-w-3xl space-y-5">
                {state.status === "error" ? (
                    <FormStatus tone="error" message={state.message} />
                ) : null}

                <div className="grid gap-5 sm:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="new-product-name">Name</Label>
                        <Input
                            id="new-product-name"
                            name="name"
                            required
                            maxLength={200}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="new-product-slug">Kürzel</Label>
                        <Input
                            id="new-product-slug"
                            name="slug"
                            maxLength={80}
                            placeholder="wird aus dem Namen gebildet"
                        />
                    </div>
                    <SelectField
                        id="new-product-group"
                        name="groupId"
                        label="Gruppe"
                        options={groups}
                        required
                    />
                    <SelectField
                        id="new-product-type"
                        name="type"
                        label="Art"
                        options={PRODUCT_TYPES}
                        defaultValue="vps"
                    />
                    <SelectField
                        id="new-product-status"
                        name="status"
                        label="Status"
                        options={PRODUCT_STATUSES}
                        defaultValue="draft"
                        help="Entwürfe tauchen weder im Shop noch in der API auf."
                    />
                    <SelectField
                        id="new-product-module"
                        name="module"
                        label="Bereitstellung"
                        options={modules}
                        defaultValue="none"
                    />
                    <div className="space-y-2 sm:col-span-2">
                        <Label htmlFor="new-product-tagline">
                            Zeile darunter
                        </Label>
                        <Input
                            id="new-product-tagline"
                            name="tagline"
                            maxLength={200}
                        />
                    </div>
                </div>

                <div className="flex gap-2">
                    <Button type="submit" disabled={pending}>
                        {pending ? "Legt an …" : "Produkt anlegen"}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setOpen(false)}
                    >
                        Abbrechen
                    </Button>
                </div>
            </form>
        </div>
    );
}
