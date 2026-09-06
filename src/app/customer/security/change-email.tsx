"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export default function ChangeEmail({ current }: { current: string }) {
    const [pending, setPending] = useState(false);
    const [state, setState] = useState<
        { kind: "idle" } | { kind: "sent"; to: string } | { kind: "error" }
    >({ kind: "idle" });

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);

        const data = new FormData(event.currentTarget);
        const newEmail = String(data.get("email") ?? "").trim();

        const { error } = await authClient.changeEmail({
            newEmail,
            callbackURL: "/customer/security",
        });

        setPending(false);
        setState(error ? { kind: "error" } : { kind: "sent", to: newEmail });
    }

    return (
        <div className="max-w-xl">
            <p className="text-sm leading-7 text-zinc-400">
                Aktuell:{" "}
                <span className="font-mono text-zinc-200">{current}</span>. Eine
                neue Adresse wird erst nach Bestätigung über den zugesandten
                Link wirksam.
            </p>

            {state.kind === "sent" ? (
                <p className="mt-6 rounded-lg border p-4 text-sm leading-6 text-zinc-300">
                    Wir haben eine Bestätigung an {state.to} geschickt. Bis zum
                    Klick auf den Link gilt deine bisherige Adresse weiter.
                </p>
            ) : null}
            {state.kind === "error" ? (
                <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                    Das hat nicht geklappt. Prüfe die Adresse und versuche es
                    erneut.
                </p>
            ) : null}

            <form onSubmit={handleSubmit} className="mt-8 space-y-6">
                <div className="space-y-3">
                    <Label htmlFor="new-email">Neue E-Mail-Adresse</Label>
                    <Input
                        id="new-email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                    />
                </div>
                <Button
                    type="submit"
                    variant="outline"
                    size="lg"
                    disabled={pending}
                >
                    {pending ? "…" : "Adresse ändern"}
                </Button>
            </form>
        </div>
    );
}
