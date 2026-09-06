"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { site } from "@/lib/site";
import { type CancellationState, submitCancellation } from "./actions";

/**
 * Kündigungsschaltfläche nach § 312k BGB. The footer link is the
 * "Verträge hier kündigen" button; this page is the Bestätigungsseite, and
 * "Jetzt kündigen" is the Bestätigungsschaltfläche.
 *
 * The declaration is sent server-side and timestamped by the server, so the
 * time of receipt does not depend on the visitor's clock.
 */

const initialState: CancellationState = { status: "idle" };

const textInputs = [
    {
        id: "contract",
        text: "Bezeichnung des Vertrags",
        placeholder: "z. B. KVM-Instanz",
        required: true,
    },
    {
        id: "number",
        text: "Vertrags- oder Kundennummer",
        placeholder: "sofern bekannt",
        required: false,
    },
    { id: "name", text: "Name", placeholder: "", required: true },
    { id: "address", text: "Anschrift", placeholder: "", required: true },
];

export default function Page() {
    const [kind, setKind] = useState<"ordentlich" | "ausserordentlich">(
        "ordentlich",
    );
    const [state, formAction, pending] = useActionState(
        submitCancellation,
        initialState,
    );

    return (
        <>
            <header className="border-b px-6 py-20 md:px-10 md:py-28">
                <p className="text-xs tracking-[0.2em] text-zinc-500 uppercase">
                    Rechtliches
                </p>
                <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                    Vertrag kündigen
                </h1>
                <p className="mt-8 max-w-2xl text-sm leading-7 text-zinc-400">
                    Hier kündigst du einen bestehenden Vertrag mit {site.name}.
                    Trage die Angaben zu deinem Vertrag ein und schließe den
                    Vorgang mit „Jetzt kündigen“ ab. Den Eingang bestätigen wir
                    dir unverzüglich per E-Mail an die von dir angegebene
                    Adresse.
                </p>
            </header>

            {state.status === "sent" ? (
                <section className="px-6 py-16 md:px-10 md:py-20">
                    <h2 className="text-sm font-medium tracking-tight">
                        Kündigung eingegangen
                    </h2>
                    <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                        Wir haben deine Kündigung am {state.receivedAt} erhalten
                        und dir eine Eingangsbestätigung an die angegebene
                        Adresse geschickt. Bewahre den folgenden Text als
                        Nachweis auf.
                    </p>
                    <pre className="mt-8 max-w-2xl overflow-x-auto rounded-lg border p-6 font-mono text-xs leading-6 text-zinc-200">
                        {state.declaration}
                    </pre>
                    <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        onClick={() => window.print()}
                        className="mt-8"
                    >
                        Erklärung drucken oder als PDF sichern
                    </Button>
                </section>
            ) : (
                <section className="px-6 py-16 md:px-10 md:py-20">
                    {state.status === "error" ? (
                        <div className="mb-10 max-w-xl rounded-lg border p-6">
                            <p className="text-sm leading-7 text-zinc-300">
                                {state.message}
                            </p>
                            {state.declaration ? (
                                <pre className="mt-6 overflow-x-auto rounded-lg border p-4 font-mono text-xs leading-6 text-zinc-400">
                                    {state.declaration}
                                </pre>
                            ) : null}
                        </div>
                    ) : null}

                    <form action={formAction} className="max-w-xl space-y-8">
                        <fieldset className="space-y-3">
                            <legend className="mb-3 text-sm text-muted-foreground">
                                Art der Kündigung
                            </legend>
                            <RadioGroup
                                name="kind"
                                value={kind}
                                onValueChange={(value) =>
                                    setKind(
                                        value as
                                            | "ordentlich"
                                            | "ausserordentlich",
                                    )
                                }
                            >
                                {(
                                    [
                                        ["ordentlich", "Ordentliche Kündigung"],
                                        [
                                            "ausserordentlich",
                                            "Außerordentliche Kündigung",
                                        ],
                                    ] as const
                                ).map(([value, text]) => (
                                    <Label
                                        key={value}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm font-normal"
                                    >
                                        <RadioGroupItem value={value} />
                                        {text}
                                    </Label>
                                ))}
                            </RadioGroup>
                        </fieldset>

                        {kind === "ausserordentlich" ? (
                            <div className="space-y-3">
                                <Label htmlFor="reason">Kündigungsgrund</Label>
                                <Textarea
                                    id="reason"
                                    name="reason"
                                    required
                                    rows={3}
                                />
                            </div>
                        ) : null}

                        {textInputs.map((input) => (
                            <div key={input.id} className="space-y-3">
                                <Label htmlFor={input.id}>{input.text}</Label>
                                <Input
                                    id={input.id}
                                    name={input.id}
                                    type="text"
                                    required={input.required}
                                    placeholder={input.placeholder}
                                />
                            </div>
                        ))}

                        <div className="space-y-3">
                            <Label htmlFor="date">Beendigung zum</Label>
                            <Input id="date" name="date" type="date" />
                            <p className="text-xs text-muted-foreground">
                                Ohne Angabe kündigen wir zum nächstmöglichen
                                Zeitpunkt.
                            </p>
                        </div>

                        <div className="space-y-3">
                            <Label htmlFor="email">
                                E-Mail-Adresse für die Bestätigung
                            </Label>
                            <Input
                                id="email"
                                name="email"
                                type="email"
                                required
                            />
                        </div>

                        <Button
                            type="submit"
                            size="lg"
                            disabled={pending}
                            className="w-full sm:w-auto"
                        >
                            {pending ? "Wird gesendet …" : "Jetzt kündigen"}
                        </Button>

                        <p className="text-xs leading-5 text-zinc-600">
                            Mit dem Absenden übermittelst du die vorstehenden
                            Angaben an {site.name}. Sie werden ausschließlich
                            zur Bearbeitung der Kündigung verarbeitet.
                        </p>
                    </form>
                </section>
            )}
        </>
    );
}
