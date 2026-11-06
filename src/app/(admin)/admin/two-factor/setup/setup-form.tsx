"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { staffAuthClient } from "@/lib/staff-auth-client";

type Setup = { uri: string; backupCodes: string[] };

export default function SetupForm() {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [setup, setSetup] = useState<Setup | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function begin(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);
        const { data: result, error: enableError } =
            await staffAuthClient.twoFactor.enable({
                password: String(data.get("password") ?? ""),
            });

        setPending(false);

        if (enableError || !result) {
            setError("Das Passwort stimmt nicht.");
            return;
        }

        // The result is a union across the plugin's methods; only the TOTP
        // branch carries a URI and backup codes.
        if (result.method !== "totp") {
            setError(
                "Die Einrichtung ist fehlgeschlagen. Bitte versuche es erneut.",
            );
            return;
        }

        setSetup({ uri: result.totpURI, backupCodes: result.backupCodes });
    }

    async function confirm(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);
        const { error: verifyError } =
            await staffAuthClient.twoFactor.verifyTotp({
                code: String(data.get("code") ?? "").trim(),
            });

        setPending(false);

        if (verifyError) {
            setError("Der Code stimmt nicht. Prüfe die Uhrzeit deines Geräts.");
            return;
        }

        router.push("/admin");
        router.refresh();
    }

    const errorBox = error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
            {error}
        </p>
    ) : null;

    if (setup) {
        return (
            <div className="space-y-6">
                <p className="text-sm leading-6 text-muted-foreground">
                    Füge das Konto in deiner Authenticator-App hinzu und
                    bestätige mit einem Code.
                </p>

                <div>
                    <p className="text-xs text-zinc-500">
                        Einrichtungsschlüssel
                    </p>
                    <pre className="mt-2 overflow-x-auto rounded-lg border p-3 font-mono text-[10px] leading-5 text-zinc-200">
                        {setup.uri}
                    </pre>
                </div>

                <div>
                    <p className="text-xs text-zinc-500">
                        Wiederherstellungscodes — jeder einmal gültig. Ohne sie
                        kommst du bei Verlust des Geräts nicht mehr hinein.
                    </p>
                    <pre className="mt-2 overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-5 text-zinc-200">
                        {setup.backupCodes.join("\n")}
                    </pre>
                </div>

                {errorBox}

                <form onSubmit={confirm} className="space-y-6">
                    <div className="space-y-3">
                        <Label htmlFor="totp-code">Code aus der App</Label>
                        <Input
                            id="totp-code"
                            name="code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            required
                        />
                    </div>
                    <Button
                        type="submit"
                        size="lg"
                        disabled={pending}
                        className="w-full"
                    >
                        {pending ? "…" : "Aktivieren"}
                    </Button>
                </form>
            </div>
        );
    }

    return (
        <form onSubmit={begin} className="space-y-6">
            {errorBox}
            <div className="space-y-3">
                <Label htmlFor="enable-password">
                    Passwort zur Bestätigung
                </Label>
                <Input
                    id="enable-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                />
            </div>
            <Button
                type="submit"
                size="lg"
                disabled={pending}
                className="w-full"
            >
                {pending ? "…" : "Einrichten"}
            </Button>
        </form>
    );
}
