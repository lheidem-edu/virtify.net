"use client";

export default function LegalPage() {
    return (
        <section className="py-24 md:py-32 flex flex-col items-center text-center gap-8 mb-16">
            <h2 className="text-5xl md:text-6xl font-extrabold tracking-tight">
                Impressum
            </h2>
            <div className="max-w-2xl w-full bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-lg p-10 flex flex-col gap-6 text-left text-zinc-200 text-base md:text-lg">
                <div>
                    <span className="font-semibold text-zinc-200">
                        Angaben gemäß § 5 DDG
                    </span>
                    <br />
                    Luca Heidemann
                    <br />
                    Hermann-Löns-Weg 19
                    <br />
                    32832 Augustdorf
                    <br />
                </div>
                <div>
                    <span className="font-semibold text-zinc-200">Kontakt</span>
                    <br />
                    E-Mail:{" "}
                    <a
                        href="mailto:admin@virtify.net"
                        className="underline hover:text-zinc-100"
                    >
                        admin@virtify.net
                    </a>
                </div>
                <div>
                    <span className="font-semibold text-zinc-200">
                        Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV
                    </span>
                    <br />
                    Luca Heidemann
                    <br />
                    Hermann-Löns-Weg 19
                    <br />
                    32832 Augustdorf
                </div>
            </div>
        </section>
    );
}
