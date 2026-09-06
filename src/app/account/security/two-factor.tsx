"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

type Setup = {
    uri: string;
    backupCodes: string[];
};

export default function TwoFactor({ enabled }: { enabled: boolean }) {
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
            await authClient.twoFactor.enable({
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

        setSetup({
            uri: result.totpURI,
            backupCodes: result.backupCodes,
        });
    }

    async function confirm(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);
        const { error: verifyError } = await authClient.twoFactor.verifyTotp({
            code: String(data.get("code") ?? "").trim(),
        });

        setPending(false);

        if (verifyError) {
            setError("Der Code stimmt nicht. Prüfe die Uhrzeit deines Geräts.");
            return;
        }

        setSetup(null);
        router.refresh();
    }

    async function disable(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const data = new FormData(event.currentTarget);
        const { error: disableError } = await authClient.twoFactor.disable({
            password: String(data.get("password") ?? ""),
        });

        setPending(false);

        if (disableError) {
            setError("Das Passwort stimmt nicht.");
            return;
        }

        router.refresh();
    }

    const errorBox = error ? (
        <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm leading-6 text-destructive">
            {error}
        </p>
    ) : null;

    if (setup) {
        return (
            <div className="max-w-xl">
                <p className="text-sm leading-7 text-zinc-400">
                    Füge das Konto in deiner Authenticator-App hinzu und
                    bestätige anschließend mit einem Code.
                </p>

                <p className="mt-6 text-sm text-zinc-500">
                    Einrichtungsschlüssel:
                </p>
                <pre className="mt-2 overflow-x-auto rounded-lg border p-4 font-mono text-xs leading-6 text-zinc-200">
                    {setup.uri}
                </pre>

                <p className="mt-8 text-sm text-zinc-500">
                    Wiederherstellungscodes — jeder ist einmal gültig. Bewahre
                    sie getrennt von deinem Gerät auf; ohne sie kommst du bei
                    Verlust des Geräts nicht mehr in dein Konto.
                </p>
                <pre className="mt-2 overflow-x-auto rounded-lg border p-4 font-mono text-xs leading-6 text-zinc-200">
                    {setup.backupCodes.join("\n")}
                </pre>

                {errorBox}

                <form onSubmit={confirm} className="mt-8 space-y-6">
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
                    <Button type="submit" size="lg" disabled={pending}>
                        {pending ? "…" : "Aktivieren"}
                    </Button>
                </form>
            </div>
        );
    }

    if (enabled) {
        return (
            <div className="max-w-xl">
                <p className="text-sm leading-7 text-zinc-400">
                    Zwei-Faktor-Authentifizierung ist aktiv. Beim Anmelden
                    fragen wir zusätzlich einen Code aus deiner
                    Authenticator-App ab.
                </p>
                {errorBox}
                <form onSubmit={disable} className="mt-8 space-y-6">
                    <div className="space-y-3">
                        <Label htmlFor="disable-password">
                            Passwort zur Bestätigung
                        </Label>
                        <Input
                            id="disable-password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            required
                        />
                    </div>
                    <Button
                        type="submit"
                        variant="outline"
                        size="lg"
                        disabled={pending}
                    >
                        {pending ? "…" : "Deaktivieren"}
                    </Button>
                </form>
            </div>
        );
    }

    return (
        <div className="max-w-xl">
            <p className="text-sm leading-7 text-zinc-400">
                Schütze dein Konto zusätzlich mit einem zeitbasierten Code aus
                einer Authenticator-App.
            </p>
            {errorBox}
            <form onSubmit={begin} className="mt-8 space-y-6">
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
                    variant="outline"
                    size="lg"
                    disabled={pending}
                >
                    {pending ? "…" : "Einrichten"}
                </Button>
            </form>
        </div>
    );
}
