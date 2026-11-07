"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import AuthShell from "@/components/shared/auth-shell";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type RegisterState, registerAccount } from "./actions";

const MIN_PASSWORD_LENGTH = 12;

const initial: RegisterState = { status: "idle" };

export default function Page() {
    const [state, formAction, pending] = useActionState(
        registerAccount,
        initial,
    );
    const [isCompany, setIsCompany] = useState(false);

    if (state.status === "sent") {
        return (
            <AuthShell
                title="Fast geschafft"
                intro={`Wir haben dir eine E-Mail an ${state.email} geschickt. Bestätige darin deine Adresse, danach kannst du dich anmelden.`}
                footer={
                    <p>
                        Nichts angekommen? Sieh im Spam-Ordner nach oder{" "}
                        <Link
                            href="/client/register"
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
            intro="Nur das Nötigste. Anschrift und weitere Angaben trägst du danach in deinen Stammdaten nach."
            footer={
                <p>
                    Schon ein Konto?{" "}
                    <Link
                        href="/client/login"
                        className="text-white underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white"
                    >
                        Anmelden
                    </Link>
                </p>
            }
        >
            <form action={formAction} className="space-y-6">
                {state.status === "error" ? (
                    <FormStatus tone="error" message={state.message} />
                ) : null}

                <fieldset className="space-y-3">
                    <legend className="text-sm text-foreground">
                        Ich melde mich an als
                    </legend>
                    <div className="flex gap-6 text-sm">
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="kind"
                                value="private"
                                defaultChecked
                                onChange={() => setIsCompany(false)}
                            />
                            Privatperson
                        </label>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="kind"
                                value="company"
                                onChange={() => setIsCompany(true)}
                            />
                            Firma
                        </label>
                    </div>
                </fieldset>

                <div className="space-y-3">
                    <Label htmlFor="name">Name</Label>
                    <Input id="name" name="name" autoComplete="name" required />
                </div>

                {isCompany ? (
                    <>
                        <div className="space-y-3">
                            <Label htmlFor="company">Firma</Label>
                            <Input
                                id="company"
                                name="company"
                                autoComplete="organization"
                                required
                            />
                        </div>
                        <div className="space-y-3">
                            <Label htmlFor="vatId">USt-IdNr. (optional)</Label>
                            <Input
                                id="vatId"
                                name="vatId"
                                autoComplete="off"
                                placeholder="DE123456789"
                            />
                            <p className="text-xs text-muted-foreground">
                                Wir berechnen nach § 19 UStG keine Umsatzsteuer.
                                Die Nummer nehmen wir für deine Unterlagen auf.
                            </p>
                        </div>
                    </>
                ) : null}

                <div className="space-y-3">
                    <Label htmlFor="country">Land</Label>
                    <Input
                        id="country"
                        name="country"
                        autoComplete="country"
                        defaultValue="DE"
                        maxLength={2}
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        Zwei Buchstaben nach ISO 3166-1, z. B. DE oder AT.
                    </p>
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
