"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import {
    type RegisterState,
    registerAccount,
} from "../../(client)/client/(auth)/register/actions";

/**
 * Signing in, or signing up, without leaving the checkout.
 *
 * The cart survives either: it hangs off an httpOnly cookie, and the first
 * page rendered after a sign-in moves a guest cart onto the account. So
 * registering here is not a detour that loses the basket — it is the step
 * before the basket becomes an order.
 *
 * Registration still requires the address to be confirmed before the first
 * sign-in. That is deliberate and is not relaxed for the checkout: an
 * unverified address is an account somebody else may own.
 */

const INITIAL: RegisterState = { status: "idle" };

export default function CheckoutIdentity() {
    return (
        <div className="grid gap-10 md:grid-cols-2">
            <SignIn />
            <Register />
        </div>
    );
}

function SignIn() {
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
                setError(
                    "Der Code stimmt nicht. Bitte versuchen Sie es erneut.",
                );

                return;
            }

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
            // Vague on purpose: naming which half was wrong would let anyone
            // check whether an address has an account here.
            setError(
                signInError.status === 403
                    ? "Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse. Den Link finden Sie in Ihrem Postfach."
                    : signInError.status === 429
                      ? "Zu viele Versuche. Bitte warten Sie einige Minuten."
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

        // The cart is merged onto the account while this page re-renders.
        router.refresh();
    }

    return (
        <section className="space-y-6 rounded-lg border p-6">
            <h2 className="text-base font-medium tracking-tight">
                {totpRequired ? "Bestätigungscode" : "Ich habe ein Konto"}
            </h2>

            <form onSubmit={handleSubmit} className="space-y-6">
                {totpRequired ? (
                    <div className="space-y-2">
                        <Label htmlFor="code">Code aus der App</Label>
                        <Input
                            id="code"
                            name="code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            required
                        />
                    </div>
                ) : (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="email">E-Mail-Adresse</Label>
                            <Input
                                id="email"
                                name="email"
                                type="email"
                                autoComplete="email"
                                required
                            />
                        </div>
                        <div className="space-y-2">
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

                {error ? (
                    <p className="text-sm text-destructive">{error}</p>
                ) : null}

                <Button type="submit" disabled={pending} className="w-full">
                    {pending ? "Einen Moment …" : "Anmelden"}
                </Button>
            </form>
        </section>
    );
}

function Register() {
    const [state, action, pending] = useActionState(registerAccount, INITIAL);

    return (
        <section className="space-y-6 rounded-lg border p-6">
            <h2 className="text-base font-medium tracking-tight">
                Ich bin neu hier
            </h2>

            {state.status === "sent" ? (
                <p className="text-sm text-zinc-400">
                    Wir haben eine Bestätigung an {state.email} geschickt.
                    Bestätigen Sie die Adresse und melden Sie sich hier an — Ihr
                    Warenkorb bleibt so lange liegen.
                </p>
            ) : (
                <form action={action} className="space-y-6">
                    <div className="space-y-2">
                        <Label htmlFor="register-name">Name</Label>
                        <Input
                            id="register-name"
                            name="name"
                            autoComplete="name"
                            required
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="register-email">E-Mail-Adresse</Label>
                        <Input
                            id="register-email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            required
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="register-password">Passwort</Label>
                        <Input
                            id="register-password"
                            name="password"
                            type="password"
                            autoComplete="new-password"
                            minLength={12}
                            required
                        />
                        <p className="text-xs text-zinc-500">
                            Mindestens zwölf Zeichen.
                        </p>
                    </div>

                    {state.status === "error" ? (
                        <p className="text-sm text-destructive">
                            {state.message}
                        </p>
                    ) : null}

                    <Button
                        type="submit"
                        variant="outline"
                        disabled={pending}
                        className="w-full"
                    >
                        {pending ? "Einen Moment …" : "Konto anlegen"}
                    </Button>
                </form>
            )}
        </section>
    );
}
