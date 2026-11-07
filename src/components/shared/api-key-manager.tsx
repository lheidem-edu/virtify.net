"use client";

import { useActionState, useState } from "react";
import FormStatus from "@/components/shared/form-status";
import StatusBadge from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format";

export type ApiKeyRow = {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
};

export type ApiKeyState = {
    status: "idle" | "created" | "revoked" | "error";
    message?: string;
    /** Present exactly once: right after creation, never again. */
    token?: string;
};

const initial: ApiKeyState = { status: "idle" };

/**
 * The same list and the same form on both sides — the only difference is
 * which scopes may be ticked and which server action is handed in, and both
 * come from the page that renders it.
 */
export default function ApiKeyManager({
    keys,
    scopes,
    createAction,
    revokeAction,
}: {
    keys: ApiKeyRow[];
    scopes: { value: string; label: string }[];
    createAction: (state: ApiKeyState, data: FormData) => Promise<ApiKeyState>;
    revokeAction: (state: ApiKeyState, data: FormData) => Promise<ApiKeyState>;
}) {
    const [createState, create, creating] = useActionState(
        createAction,
        initial,
    );
    const [revokeState, revoke, revoking] = useActionState(
        revokeAction,
        initial,
    );
    const [copied, setCopied] = useState(false);

    return (
        <div className="space-y-10">
            {createState.status === "created" && createState.token ? (
                <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
                    <p className="text-sm text-foreground">
                        Das ist der Schlüssel. Er wird genau einmal angezeigt —
                        wir speichern nur seinen Hash und können ihn nicht
                        wiederherstellen.
                    </p>
                    <code className="block overflow-x-auto rounded-md border bg-background p-3 font-mono text-xs">
                        {createState.token}
                    </code>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            navigator.clipboard
                                ?.writeText(createState.token ?? "")
                                .then(() => setCopied(true))
                                .catch(() => setCopied(false));
                        }}
                    >
                        {copied ? "Kopiert" : "Kopieren"}
                    </Button>
                </div>
            ) : null}

            {createState.status === "error" ? (
                <FormStatus tone="error" message={createState.message} />
            ) : null}
            {revokeState.status === "error" ? (
                <FormStatus tone="error" message={revokeState.message} />
            ) : null}
            {revokeState.status === "revoked" ? (
                <FormStatus
                    tone="success"
                    message="Der Schlüssel wurde widerrufen."
                />
            ) : null}

            <form action={create} className="max-w-xl space-y-5">
                <div className="space-y-2">
                    <Label htmlFor="key-name">Bezeichnung</Label>
                    <Input
                        id="key-name"
                        name="name"
                        required
                        maxLength={100}
                        placeholder="z. B. Buchhaltung"
                    />
                </div>

                <fieldset className="space-y-3">
                    <legend className="text-sm text-foreground">
                        Berechtigungen
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {scopes.map((scope) => (
                            <label
                                key={scope.value}
                                className="flex items-start gap-2 text-sm"
                            >
                                <input
                                    type="checkbox"
                                    name="scopes"
                                    value={scope.value}
                                    className="mt-1"
                                />
                                <span>
                                    {scope.label}
                                    <code className="ml-2 font-mono text-xs text-muted-foreground">
                                        {scope.value}
                                    </code>
                                </span>
                            </label>
                        ))}
                    </div>
                </fieldset>

                <Button type="submit" disabled={creating}>
                    {creating ? "Erzeugt …" : "Schlüssel erzeugen"}
                </Button>
            </form>

            <div>
                <h3 className="mb-4 text-sm font-medium tracking-tight">
                    Vorhandene Schlüssel
                </h3>

                {keys.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Noch kein Schlüssel erzeugt.
                    </p>
                ) : (
                    <ul className="space-y-3">
                        {keys.map((key) => (
                            <li
                                key={key.id}
                                className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm"
                            >
                                <span className="font-medium">{key.name}</span>
                                <code className="font-mono text-xs text-muted-foreground">
                                    {key.prefix}…
                                </code>
                                <span className="text-xs text-muted-foreground">
                                    {key.scopes.join(", ") ||
                                        "keine Berechtigung"}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {key.lastUsedAt
                                        ? `zuletzt ${formatDate(key.lastUsedAt)}`
                                        : "nie benutzt"}
                                </span>
                                {key.revokedAt ? (
                                    <StatusBadge
                                        label="Widerrufen"
                                        tone="muted"
                                    />
                                ) : (
                                    <form action={revoke} className="ml-auto">
                                        <input
                                            type="hidden"
                                            name="keyId"
                                            value={key.id}
                                        />
                                        <Button
                                            type="submit"
                                            variant="ghost"
                                            size="sm"
                                            disabled={revoking}
                                        >
                                            Widerrufen
                                        </Button>
                                    </form>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
