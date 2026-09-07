"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import AuthShell from "@/lib/components/account/auth-shell";
import { staffAuthClient } from "@/lib/staff-auth-client";

/**
 * The employees' door. Deliberately not linked from the customer login: this
 * is a different account with a different password, even when the address is
 * the same one a customer signs in with.
 */
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
            const { error } = await staffAuthClient.twoFactor.verifyTotp({
                code: String(data.get("code") ?? "").trim(),
            });

            setPending(false);

            if (error) {
                setError(
                    error.status === 429
                        ? "Zu viele Versuche. Bitte warte einige Minuten."
                        : "Der Code stimmt nicht. Bitte versuche es erneut.",
                );
                return;
            }

            router.push("/admin");
            router.refresh();
            return;
        }

        const { data: result, error: signInError } =
            await staffAuthClient.signIn.email({
                email: String(data.get("email") ?? "").trim(),
                password: String(data.get("password") ?? ""),
            });

        setPending(false);

        if (signInError) {
            setError(
                signInError.status === 429
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

        router.push("/admin");
        router.refresh();
    }

    return (
        <AuthShell
            title={totpRequired ? "Bestätigungscode" : "Verwaltung"}
            intro={
                totpRequired
                    ? "Gib den sechsstelligen Code aus deiner Authenticator-App ein."
                    : "Anmeldung für Mitarbeiter. Das Kundenkonto hat eine eigene Anmeldung und ein eigenes Passwort."
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
