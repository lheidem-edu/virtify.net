"use client";

import { useState } from "react";
import { operator, site } from "@/lib/site";

/**
 * Kündigungsschaltfläche nach § 312k BGB. The footer link is the
 * "Verträge hier kündigen" button; this page is the Bestätigungsseite, and
 * "Jetzt kündigen" is the Bestätigungsschaltfläche.
 *
 * TODO once online ordering is live: the confirmation button must POST to an
 * endpoint that stores the declaration and sends the § 312k Abs. 5 receipt in
 * text form automatically. Until then it composes the declaration as a mail,
 * which still transmits it but relies on the visitor's mail client.
 */

const field =
    "w-full border bg-transparent px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none";
const label = "block text-sm text-zinc-400";

export default function Page() {
    const [kind, setKind] = useState<"ordentlich" | "ausserordentlich">(
        "ordentlich",
    );
    const [declaration, setDeclaration] = useState<string | null>(null);

    function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const value = (name: string) => String(data.get(name) ?? "").trim();

        const stamp = new Date();
        const text = [
            `Kündigungserklärung an ${site.name}`,
            `Erstellt am ${stamp.toLocaleString("de-DE")}`,
            "",
            `Art der Kündigung: ${kind === "ordentlich" ? "Ordentliche Kündigung" : "Außerordentliche Kündigung"}`,
            kind === "ausserordentlich"
                ? `Kündigungsgrund: ${value("reason") || "—"}`
                : null,
            `Bezeichnung des Vertrags: ${value("contract") || "—"}`,
            `Vertrags- oder Kundennummer: ${value("number") || "—"}`,
            `Beendigung zum: ${value("date") || "nächstmöglichen Zeitpunkt"}`,
            "",
            `Name: ${value("name")}`,
            `Anschrift: ${value("address")}`,
            `E-Mail für die Bestätigung: ${value("email")}`,
        ]
            .filter(Boolean)
            .join("\n");

        setDeclaration(text);

        const subject = `Kündigung — ${value("contract") || value("number") || value("name")}`;
        window.location.href = `mailto:${operator.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    }

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

            {declaration ? (
                <section className="px-6 py-16 md:px-10 md:py-20">
                    <h2 className="text-sm font-medium tracking-tight">
                        Deine Kündigungserklärung
                    </h2>
                    <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                        Bewahre diesen Text auf — er ist dein Nachweis mit Datum
                        und Uhrzeit. Es hat sich ein E-Mail-Entwurf an{" "}
                        {operator.email} geöffnet; bitte sende ihn ab. Den
                        Eingang bestätigen wir dir anschließend in Textform.
                    </p>
                    <pre className="mt-8 max-w-2xl overflow-x-auto border p-6 font-mono text-xs leading-6 text-zinc-200">
                        {declaration}
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
                    <form
                        onSubmit={handleSubmit}
                        className="max-w-xl space-y-8"
                    >
                        <fieldset className="space-y-3">
                            <legend className={label}>Art der Kündigung</legend>
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
                                <label className={label} htmlFor="reason">
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

                        {[
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
                            {
                                id: "name",
                                text: "Name",
                                placeholder: "",
                                required: true,
                            },
                            {
                                id: "address",
                                text: "Anschrift",
                                placeholder: "",
                                required: true,
                            },
                        ].map((input) => (
                            <div key={input.id} className="space-y-3">
                                <label className={label} htmlFor={input.id}>
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
                            <label className={label} htmlFor="date">
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
                            <label className={label} htmlFor="email">
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
                            className="w-full border border-white bg-white px-6 py-4 text-sm font-medium text-black transition-colors hover:bg-zinc-300 sm:w-auto"
                        >
                            Jetzt kündigen
                        </button>
                    </form>
                </section>
            )}
        </>
    );
}
