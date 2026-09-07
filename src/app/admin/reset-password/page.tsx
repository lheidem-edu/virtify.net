"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import AuthShell from "@/lib/components/account/auth-shell";
import { staffAuthClient } from "@/lib/staff-auth-client";

const MIN_PASSWORD_LENGTH = 12;

/**
 * Where an invitation lands, and where a forgotten staff password is set.
 * The password belongs to the employee account alone — a customer account
 * under the same address keeps the one it has.
 */
function ResetForm() {
    const router = useRouter();
    const token = useSearchParams().get("token");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!token) {
        return (
            <AuthShell
                title="Link ungültig"
                intro="Dieser Link ist unvollständig oder abgelaufen. Bitte lass dir eine neue Einladung senden."
            >
                <p className="text-sm leading-7 text-zinc-500">
                    Aus Sicherheitsgründen sind diese Links nur begrenzt gültig.
                </p>
            </AuthShell>
        );
    }

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);
        const { error: resetError } = await staffAuthClient.resetPassword({
            token: token as string,
            newPassword: String(data.get("password") ?? ""),
        });

        setPending(false);

        if (resetError) {
            setError(
                "Das hat nicht geklappt. Der Link ist womöglich abgelaufen — bitte lass dir einen neuen senden.",
            );
            return;
        }

        router.push("/admin/login");
    }

    return (
        <AuthShell
            title="Passwort festlegen"
            intro="Für deinen Zugang zur Verwaltung. Ein Kundenkonto unter derselben Adresse ist davon nicht betroffen."
        >
            <form onSubmit={handleSubmit} className="space-y-6">
                {error ? (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                        {error}
                    </p>
                ) : null}
                <div className="space-y-3">
                    <Label htmlFor="password">Passwort</Label>
                    <Input
                        id="password"
                        name="password"
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
                    size="lg"
                    disabled={pending}
                    className="w-full"
                >
                    {pending ? "…" : "Passwort speichern"}
                </Button>
            </form>
        </AuthShell>
    );
}

export default function Page() {
    return (
        <Suspense>
            <ResetForm />
        </Suspense>
    );
}
