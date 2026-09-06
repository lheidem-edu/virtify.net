"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import AuthShell from "@/lib/components/customer/auth-shell";

const MIN_PASSWORD_LENGTH = 12;

export default function Page() {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string | null>(null);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);
        const email = String(data.get("email") ?? "").trim();
        const password = String(data.get("password") ?? "");

        if (password.length < MIN_PASSWORD_LENGTH) {
            setPending(false);
            setError(
                `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`,
            );
            return;
        }

        const { error: signUpError } = await authClient.signUp.email({
            email,
            password,
            name: String(data.get("name") ?? "").trim(),
        });

        setPending(false);

        if (signUpError) {
            setError(
                signUpError.message ??
                    "Die Registrierung hat nicht geklappt. Bitte versuche es später erneut.",
            );
            return;
        }

        setSentTo(email);
    }

    if (sentTo) {
        return (
            <AuthShell
                title="Fast geschafft"
                intro={`Wir haben dir eine E-Mail an ${sentTo} geschickt. Bestätige darin deine Adresse, danach kannst du dich anmelden.`}
                footer={
                    <p>
                        Nichts angekommen? Sieh im Spam-Ordner nach oder{" "}
                        <Link
                            href="/customer/register"
                            className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                        >
                            versuche es erneut
                        </Link>
                        .
                    </p>
                }
            >
                <p className="text-sm leading-7 text-zinc-500">
                    Der Bestätigungslink ist aus Sicherheitsgründen nur begrenzt
                    gültig.
                </p>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            title="Konto anlegen"
            intro="Du brauchst nur eine E-Mail-Adresse und ein Passwort. Deine Stammdaten trägst du danach im Profil nach."
            footer={
                <p>
                    Schon ein Konto?{" "}
                    <Link
                        href="/customer/login"
                        className="text-white underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white"
                    >
                        Anmelden
                    </Link>
                </p>
            }
        >
            <form onSubmit={handleSubmit} className="space-y-6">
                {error ? (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
                        {error}
                    </p>
                ) : null}

                <div className="space-y-3">
                    <Label htmlFor="name">Name</Label>
                    <Input id="name" name="name" autoComplete="name" required />
                </div>
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
                    {pending ? "…" : "Konto anlegen"}
                </Button>
            </form>
        </AuthShell>
    );
}
