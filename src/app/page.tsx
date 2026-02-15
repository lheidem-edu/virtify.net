"use client";

export default function Page() {
    return (
        <>
            <section className="py-24 md:py-32 flex flex-col items-center text-center gap-8">
                <h2 className="text-7xl font-extrabold tracking-tight">
                    Hosting, das einfach funktioniert.
                </h2>
                <div className="max-w-2xl text-lg font-medium">
                    <p className="max-w-2xl text-lg text-zinc-400 font-medium">
                        Vollständig automatisiert, skalierbar und zuverlässig.
                    </p>
                    <p className="text-zinc-600">
                        Virtify ist die moderne Hosting-Plattform für Developer
                        und Unternehmen, die sich auf ihr Produkt konzentrieren
                        wollen.
                    </p>
                </div>
            </section>

            <section className="py-20 flex flex-col items-center border-t border-zinc-600/40">
                <div className="w-full max-w-xl bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-lg p-10 flex flex-col items-center gap-6">
                    <h2 className="text-4xl md:text-5xl font-extrabold text-zinc-100 tracking-tight text-center">
                        Bald verfügbar
                    </h2>
                    <p className="text-zinc-400 text-base md:text-lg text-center">
                        Trage dich in unsere Warteliste ein und erhalte
                        exklusiven Zugang, sobald wir live gehen –
                        <br className="hidden md:block" />
                        <span className="text-zinc-300">
                            plus besondere Vorteile für Early Adopters.
                        </span>
                    </p>
                    <form className="w-full flex flex-col md:flex-row gap-4 mt-2">
                        <input
                            type="email"
                            required
                            placeholder="Deine E-Mail-Adresse"
                            className="flex-1 px-5 py-3 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 transition"
                        />
                        <button
                            type="submit"
                            className="px-6 py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-white transition border border-zinc-300 shadow"
                        >
                            Warteliste
                        </button>
                    </form>
                    <p className="text-xs text-zinc-600 text-center">
                        Keine Werbung. Du kannst dich jederzeit austragen.
                        Aktuell ohne Funktion, da wir uns noch in der
                        Entwicklung befinden.
                    </p>
                </div>
            </section>
        </>
    );
}
