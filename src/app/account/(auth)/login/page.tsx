"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import AuthShell from "@/lib/components/account/auth-shell";

export default function Page() {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [totpRequired, setTotpRequired] = useState(false);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);

        if (totpRequired) {
            const { error } = await authClient.twoFactor.verifyTotp({
                code: String(data.get("code") ?? "").trim(),
            });

            setPending(false);

            if (error) {
                setError("Der Code stimmt nicht. Bitte versuche es erneut.");
                return;
            }

            router.push("/account");
            router.refresh();
            return;
        }

        const { data: result, error: signInError } =
            await authClient.signIn.email({
                email: String(data.get("email") ?? "").trim(),
                password: String(data.get("password") ?? ""),
            });

        setPending(false);

        if (signInError) {
            // Deliberately vague: naming which half was wrong would let
            // anyone check whether an address has an account here.
            setError(
                signInError.status === 403
                    ? "Bitte bestätige zuerst deine E-Mail-Adresse. Den Link findest du in deinem Postfach."
                    : signInError.status === 429
                      ? "Zu viele Versuche. Bitte warte einige Minuten."
                      : "E-Mail-Adresse oder Passwort stimmt nicht.",
            );
            return;
        }

        if (
            result &&
            "twoFactorRedirect" in result &&
            result.twoFactorRedirect
        ) {
            setTotpRequired(true);
            return;
        }

        router.push("/account");
        router.refresh();
    }

    return (
        <AuthShell
            title={totpRequired ? "Bestätigungscode" : "Anmelden"}
            intro={
                totpRequired
                    ? "Gib den sechsstelligen Code aus deiner Authenticator-App ein."
                    : "Melde dich an, um deine Verträge und Stammdaten zu sehen."
            }
            footer={
                totpRequired ? null : (
                    <>
                        <p>
                            Noch kein Konto?{" "}
                            <Link
                                href="/account/register"
                                className="text-white underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white"
                            >
                                Registrieren
                            </Link>
                        </p>
                        <p className="mt-2">
                            <Link
                                href="/account/forgot-password"
                                className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                            >
                                Passwort vergessen?
                            </Link>
                        </p>
                    </>
                )
            }
        >
            <form onSubmit={handleSubmit} className="space-y-6">
                {error ? (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                        {error}
                    </p>
                ) : null}

                {totpRequired ? (
                    <div className="space-y-3">
                        <Label htmlFor="code">Code</Label>
                        <Input
                            id="code"
                            name="code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            required
                            autoFocus
                        />
                    </div>
                ) : (
                    <>
                        <div className="space-y-3">
                            <Label htmlFor="email">E-Mail-Adresse</Label>
                            <Input
                                id="email"
                                name="email"
                                type="email"
                                autoComplete="email"
                                required
                            />
                        </div>
                        <div className="space-y-3">
                            <Label htmlFor="password">Passwort</Label>
                            <Input
                                id="password"
                                name="password"
                                type="password"
                                autoComplete="current-password"
                                required
                            />
                        </div>
                    </>
                )}

                <Button
                    type="submit"
                    size="lg"
                    disabled={pending}
                    className="w-full"
                >
                    {pending ? "…" : totpRequired ? "Bestätigen" : "Anmelden"}
                </Button>
            </form>
        </AuthShell>
    );
}
