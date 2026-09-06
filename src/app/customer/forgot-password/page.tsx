"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import AuthShell from "@/lib/components/customer/auth-shell";

export default function Page() {
    const [pending, setPending] = useState(false);
    const [done, setDone] = useState(false);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);

        const data = new FormData(event.currentTarget);
        await authClient.requestPasswordReset({
            email: String(data.get("email") ?? "").trim(),
            redirectTo: "/customer/reset-password",
        });

        // Always report the same outcome, whether or not the address exists —
        // otherwise this page becomes a way to test for accounts.
        setPending(false);
        setDone(true);
    }

    if (done) {
        return (
            <AuthShell
                title="E-Mail unterwegs"
                intro="Falls ein Konto mit dieser Adresse besteht, haben wir dir einen Link zum Zurücksetzen geschickt."
                footer={
                    <Link
                        href="/customer/login"
                        className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                    >
                        Zurück zur Anmeldung
                    </Link>
                }
            >
                <p className="text-sm leading-7 text-zinc-500">
                    Der Link ist aus Sicherheitsgründen nur begrenzt gültig.
                </p>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            title="Passwort vergessen"
            intro="Gib deine E-Mail-Adresse ein. Wir schicken dir einen Link, mit dem du ein neues Passwort setzen kannst."
            footer={
                <Link
                    href="/customer/login"
                    className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                >
                    Zurück zur Anmeldung
                </Link>
            }
        >
            <form onSubmit={handleSubmit} className="space-y-6">
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
                <Button
                    type="submit"
                    size="lg"
                    disabled={pending}
                    className="w-full"
                >
                    {pending ? "…" : "Link anfordern"}
                </Button>
            </form>
        </AuthShell>
    );
}
