"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import AuthShell from "@/lib/components/account/auth-shell";

const MIN_PASSWORD_LENGTH = 12;

function ResetForm() {
    const router = useRouter();
    const token = useSearchParams().get("token");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!token) {
        return (
            <AuthShell
                title="Link ungültig"
                intro="Dieser Link ist unvollständig oder abgelaufen. Fordere bitte einen neuen an."
                footer={
                    <Link
                        href="/account/forgot-password"
                        className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                    >
                        Neuen Link anfordern
                    </Link>
                }
            >
                <p className="text-sm leading-7 text-zinc-500">
                    Aus Sicherheitsgründen sind Links zum Zurücksetzen nur
                    begrenzt gültig.
                </p>
            </AuthShell>
        );
    }

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);
        const { error: resetError } = await authClient.resetPassword({
            token: token as string,
            newPassword: String(data.get("password") ?? ""),
        });

        setPending(false);

        if (resetError) {
            setError(
                "Das hat nicht geklappt. Der Link ist womöglich abgelaufen — fordere bitte einen neuen an.",
            );
            return;
        }

        router.push("/account/login");
    }

    return (
        <AuthShell
            title="Neues Passwort setzen"
            intro="Wähle ein neues Passwort für dein Konto."
        >
            <form onSubmit={handleSubmit} className="space-y-6">
                {error ? (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                        {error}
                    </p>
                ) : null}
                <div className="space-y-3">
                    <Label htmlFor="password">Neues Passwort</Label>
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
