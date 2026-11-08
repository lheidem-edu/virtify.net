"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type MailSettingsState, saveDepartmentAction } from "./actions";

const INITIAL: MailSettingsState = { status: "idle" };

export default function DepartmentForm({
    id,
    name,
    slug,
    mailbox,
    description,
    isDefault,
    active,
}: {
    id?: string;
    name?: string;
    slug?: string;
    mailbox?: string;
    description?: string | null;
    isDefault?: boolean;
    active?: boolean;
} = {}) {
    const [state, action, pending] = useActionState(
        saveDepartmentAction,
        INITIAL,
    );

    return (
        <form action={action} className="space-y-4 rounded-lg border p-4">
            {id ? <input type="hidden" name="id" value={id} /> : null}

            <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor={`name-${id ?? "new"}`}>Name</Label>
                    <Input
                        id={`name-${id ?? "new"}`}
                        name="name"
                        defaultValue={name ?? ""}
                        required
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`mailbox-${id ?? "new"}`}>Postfach</Label>
                    <Input
                        id={`mailbox-${id ?? "new"}`}
                        name="mailbox"
                        defaultValue={mailbox ?? ""}
                        placeholder="support@example.net"
                        required
                    />
                </div>
            </div>

            <div className="space-y-2">
                <Label htmlFor={`slug-${id ?? "new"}`}>Kürzel</Label>
                <Input
                    id={`slug-${id ?? "new"}`}
                    name="slug"
                    defaultValue={slug ?? ""}
                    placeholder="wird aus dem Namen gebildet"
                />
            </div>

            <div className="space-y-2">
                <Label htmlFor={`description-${id ?? "new"}`}>
                    Beschreibung im Kundenbereich
                </Label>
                <Input
                    id={`description-${id ?? "new"}`}
                    name="description"
                    defaultValue={description ?? ""}
                />
            </div>

            <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        name="isDefault"
                        defaultChecked={isDefault}
                    />
                    Standard
                </label>
                <label className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        name="active"
                        defaultChecked={active ?? true}
                    />
                    Aktiv
                </label>
            </div>

            <Button type="submit" variant="outline" disabled={pending}>
                {pending
                    ? "Speichere…"
                    : id
                      ? "Speichern"
                      : "Abteilung anlegen"}
            </Button>

            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}
