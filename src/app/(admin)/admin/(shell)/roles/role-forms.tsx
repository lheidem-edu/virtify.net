"use client";

import { useActionState, useState } from "react";
import FormStatus from "@/components/shared/form-status";
import StatusBadge from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    addRole,
    assignRoles,
    type RoleState,
    removeRole,
    saveRole,
} from "./actions";

export type Role = {
    id: string;
    name: string;
    description: string | null;
    permissions: string[];
    isSystem: boolean;
};

export type Member = {
    id: string;
    name: string;
    email: string;
    roleIds: string[];
};

const initial: RoleState = { status: "idle" };

function PermissionBoxes({
    catalogue,
    checked,
    disabled,
    name = "permissions",
}: {
    catalogue: { value: string; label: string }[];
    checked: string[];
    disabled?: boolean;
    name?: string;
}) {
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            {catalogue.map((entry) => (
                <label
                    key={entry.value}
                    className="flex items-start gap-2 text-sm"
                >
                    <input
                        type="checkbox"
                        name={name}
                        value={entry.value}
                        defaultChecked={checked.includes(entry.value)}
                        disabled={disabled}
                        className="mt-1"
                    />
                    <span>
                        {entry.label}
                        <code className="ml-2 font-mono text-xs text-muted-foreground">
                            {entry.value}
                        </code>
                    </span>
                </label>
            ))}
        </div>
    );
}

export function NewRole({
    catalogue,
}: {
    catalogue: { value: string; label: string }[];
}) {
    const [state, action, pending] = useActionState(addRole, initial);
    const [open, setOpen] = useState(false);

    if (!open) {
        return (
            <Button variant="outline" onClick={() => setOpen(true)}>
                Neue Rolle
            </Button>
        );
    }

    return (
        <form action={action} className="max-w-3xl space-y-5">
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor="role-name">Name</Label>
                    <Input
                        id="role-name"
                        name="name"
                        required
                        maxLength={64}
                        placeholder="z. B. Buchhaltung"
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="role-description">Beschreibung</Label>
                    <Input
                        id="role-description"
                        name="description"
                        maxLength={200}
                    />
                </div>
            </div>

            <PermissionBoxes catalogue={catalogue} checked={[]} />

            <div className="flex gap-3">
                <Button type="submit" disabled={pending}>
                    {pending ? "Legt an …" : "Rolle anlegen"}
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
    );
}

export function RoleCard({
    role,
    catalogue,
}: {
    role: Role;
    catalogue: { value: string; label: string }[];
}) {
    const [state, action, pending] = useActionState(saveRole, initial);
    const [deleteState, remove, deleting] = useActionState(removeRole, initial);

    return (
        <div className="space-y-5 rounded-lg border p-6">
            <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-medium">{role.name}</h3>
                {role.isSystem ? (
                    <StatusBadge label="Systemrolle" tone="positive" />
                ) : null}
                {role.description ? (
                    <span className="text-xs text-muted-foreground">
                        {role.description}
                    </span>
                ) : null}
            </div>

            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            {deleteState.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={deleteState.message}
                    variant="inline"
                />
            ) : null}

            {role.isSystem ? (
                <p className="text-sm text-muted-foreground">
                    Darf alles (<code className="font-mono text-xs">*</code>)
                    und lässt sich weder einschränken noch löschen — sonst
                    könnte sich die Verwaltung selbst aussperren.
                </p>
            ) : (
                <form action={action} className="space-y-5">
                    <input type="hidden" name="roleId" value={role.id} />
                    <PermissionBoxes
                        catalogue={catalogue}
                        checked={role.permissions}
                    />
                    <div className="flex gap-3">
                        <Button type="submit" size="sm" disabled={pending}>
                            {pending ? "Speichert …" : "Speichern"}
                        </Button>
                    </div>
                </form>
            )}

            {role.isSystem ? null : (
                <form action={remove}>
                    <input type="hidden" name="roleId" value={role.id} />
                    <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        disabled={deleting}
                    >
                        Rolle löschen
                    </Button>
                </form>
            )}
        </div>
    );
}

export function MemberRoles({
    member,
    roles,
}: {
    member: Member;
    roles: Role[];
}) {
    const [state, action, pending] = useActionState(assignRoles, initial);

    return (
        <form
            action={action}
            className="flex flex-wrap items-center gap-4 rounded-lg border p-4 text-sm"
        >
            <input type="hidden" name="staffUserId" value={member.id} />
            <div className="min-w-48">
                <span className="block">{member.name}</span>
                <span className="text-xs text-muted-foreground">
                    {member.email}
                </span>
            </div>

            <div className="flex flex-wrap gap-4">
                {roles.map((role) => (
                    <label key={role.id} className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            name="roleIds"
                            value={role.id}
                            defaultChecked={member.roleIds.includes(role.id)}
                        />
                        {role.name}
                    </label>
                ))}
            </div>

            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
                className="ml-auto"
            >
                {pending ? "…" : "Übernehmen"}
            </Button>

            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
        </form>
    );
}
