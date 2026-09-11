"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import FormStatus from "@/lib/components/account/form-status";
import { staffAuthClient } from "@/lib/staff-auth-client";

const MIN_PASSWORD_LENGTH = 12;

export default function PasswordForm() {
    const [pending, setPending] = useState(false);
    const [state, setState] = useState<{
        tone: "success" | "error";
        message: string;
    } | null>(null);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setState(null);

        const form = event.currentTarget;
        const data = new FormData(form);

        const { error } = await staffAuthClient.changePassword({
            currentPassword: String(data.get("current") ?? ""),
            newPassword: String(data.get("next") ?? ""),
            // Anything still signed in with the old password should stop
            // being signed in.
            revokeOtherSessions: true,
        });

        setPending(false);

        if (error) {
            setState({
                tone: "error",
                message: "Das bisherige Passwort stimmt nicht.",
            });
            return;
        }

        form.reset();
        setState({ tone: "success", message: "Passwort geändert." });
    }

    return (
        <form onSubmit={handleSubmit} className="max-w-xl space-y-6">
            {state ? (
                <FormStatus tone={state.tone} message={state.message} />
            ) : null}

            <div className="space-y-3">
                <Label htmlFor="current">Bisheriges Passwort</Label>
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

            <Button type="submit" disabled={pending}>
                {pending ? "…" : "Passwort ändern"}
            </Button>
        </form>
    );
}
