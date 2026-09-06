"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

const MIN_PASSWORD_LENGTH = 12;

export default function ChangePassword() {
    const [pending, setPending] = useState(false);
    const [state, setState] = useState<
        | { kind: "idle" }
        | { kind: "saved" }
        | { kind: "error"; message: string }
    >({ kind: "idle" });

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);

        const form = event.currentTarget;
        const data = new FormData(form);

        const { error } = await authClient.changePassword({
            currentPassword: String(data.get("current") ?? ""),
            newPassword: String(data.get("next") ?? ""),
            // Any other device stays signed in only if the change was
            // routine; a compromised password should not survive it.
            revokeOtherSessions: true,
        });

        setPending(false);

        if (error) {
            setState({
                kind: "error",
                message: "Das aktuelle Passwort stimmt nicht.",
            });
            return;
        }

        form.reset();
        setState({ kind: "saved" });
    }

    return (
        <div className="max-w-xl">
            <p className="text-sm leading-7 text-zinc-400">
                Nach einer Änderung werden alle anderen angemeldeten Geräte
                abgemeldet.
            </p>

            {state.kind === "saved" ? (
                <p className="mt-6 rounded-lg border p-4 text-sm leading-6 text-zinc-300">
                    Passwort geändert.
                </p>
            ) : null}
            {state.kind === "error" ? (
                <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                    {state.message}
                </p>
            ) : null}

            <form onSubmit={handleSubmit} className="mt-8 space-y-6">
                <div className="space-y-3">
                    <Label htmlFor="current">Aktuelles Passwort</Label>
                    <Input
                        id="current"
                        name="current"
                        type="password"
                        autoComplete="current-password"
                        required
                    />
                </div>
                <div className="space-y-3">
                    <Label htmlFor="next">Neues Passwort</Label>
                    <Input
                        id="next"
                        name="next"
                        type="password"
                        autoComplete="new-password"
                        minLength={MIN_PASSWORD_LENGTH}
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        Mindestens {MIN_PASSWORD_LENGTH} Zeichen.
                    </p>
                </div>
                <Button
                    type="submit"
                    variant="outline"
                    size="lg"
                    disabled={pending}
                >
                    {pending ? "…" : "Passwort ändern"}
                </Button>
            </form>
        </div>
    );
}
