"use client";

import { useActionState, useState } from "react";
import { operator, site } from "@/lib/site";
import { type CancellationState, submitCancellation } from "./actions";

/**
 * Kündigungsschaltfläche nach § 312k BGB. The footer link is the
 * "Verträge hier kündigen" button; this page is the Bestätigungsseite, and
 * "Jetzt kündigen" is the Bestätigungsschaltfläche.
 *
 * The declaration is sent server-side and timestamped by the server, so the
 * time of receipt does not depend on the visitor's clock.
 */

const field =
    "w-full border bg-transparent px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none";
const labelClass = "block text-sm text-zinc-400";

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
                    Über dieses Formular kannst du einen bestehenden Vertrag
                    kündigen. Es ist die Bestätigungsseite der
                    Kündigungsschaltfläche nach § 312k BGB. Eine Kündigung ist
                    daneben jederzeit formlos in Textform möglich, etwa per
                    E-Mail an {operator.email}.
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
                    <pre className="mt-8 max-w-2xl overflow-x-auto border p-6 font-mono text-xs leading-6 text-zinc-200">
                        {state.declaration}
                    </pre>
                    <button
                        type="button"
                        onClick={() => window.print()}
                        className="mt-8 border px-5 py-3 text-sm transition-colors hover:border-white hover:bg-white hover:text-black"
                    >
                        Erklärung drucken oder als PDF sichern
                    </button>
                </section>
            ) : (
                <section className="px-6 py-16 md:px-10 md:py-20">
                    {state.status === "error" ? (
                        <div className="mb-10 max-w-xl border p-6">
                            <p className="text-sm leading-7 text-zinc-300">
                                {state.message}
                            </p>
                            {state.declaration ? (
                                <pre className="mt-6 overflow-x-auto border p-4 font-mono text-xs leading-6 text-zinc-400">
                                    {state.declaration}
                                </pre>
                            ) : null}
                        </div>
                    ) : null}

                    <form action={formAction} className="max-w-xl space-y-8">
                        <fieldset className="space-y-3">
                            <legend className={labelClass}>
                                Art der Kündigung
                            </legend>
                            {(
                                [
                                    ["ordentlich", "Ordentliche Kündigung"],
                                    [
                                        "ausserordentlich",
                                        "Außerordentliche Kündigung",
                                    ],
                                ] as const
                            ).map(([value, text]) => (
                                <label
                                    key={value}
                                    className="flex cursor-pointer items-center gap-3 border px-4 py-3 text-sm"
                                >
                                    <input
                                        type="radio"
                                        name="kind"
                                        value={value}
                                        checked={kind === value}
                                        onChange={() => setKind(value)}
                                        className="accent-white"
                                    />
                                    {text}
                                </label>
                            ))}
                        </fieldset>

                        {kind === "ausserordentlich" ? (
                            <div className="space-y-3">
                                <label className={labelClass} htmlFor="reason">
                                    Kündigungsgrund
                                </label>
                                <textarea
                                    id="reason"
                                    name="reason"
                                    required
                                    rows={3}
                                    className={field}
                                />
                            </div>
                        ) : null}

                        {textInputs.map((input) => (
                            <div key={input.id} className="space-y-3">
                                <label
                                    className={labelClass}
                                    htmlFor={input.id}
                                >
                                    {input.text}
                                </label>
                                <input
                                    id={input.id}
                                    name={input.id}
                                    type="text"
                                    required={input.required}
                                    placeholder={input.placeholder}
                                    className={field}
                                />
                            </div>
                        ))}

                        <div className="space-y-3">
                            <label className={labelClass} htmlFor="date">
                                Beendigung zum
                            </label>
                            <input
                                id="date"
                                name="date"
                                type="date"
                                className={field}
                            />
                            <p className="text-xs text-zinc-600">
                                Ohne Angabe kündigen wir zum nächstmöglichen
                                Zeitpunkt.
                            </p>
                        </div>

                        <div className="space-y-3">
                            <label className={labelClass} htmlFor="email">
                                E-Mail-Adresse für die Bestätigung
                            </label>
                            <input
                                id="email"
                                name="email"
                                type="email"
                                required
                                className={field}
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={pending}
                            className="w-full border border-white bg-white px-6 py-4 text-sm font-medium text-black transition-colors hover:bg-zinc-300 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        >
                            {pending ? "Wird gesendet …" : "Jetzt kündigen"}
                        </button>

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
