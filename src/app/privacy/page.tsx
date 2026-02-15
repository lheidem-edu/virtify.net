export default function PrivacyPage() {
    return (
        <section className="py-24 md:py-32 flex flex-col items-center text-center gap-8 mb-16">
            <h2 className="text-5xl md:text-6xl font-extrabold tracking-tight">
                Datenschutz
            </h2>
            <div className="max-w-2xl w-full bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-lg p-10 flex flex-col gap-6 text-left text-zinc-200 text-base md:text-lg">
                <p>
                    Aktuell werden keinerlei personenbezogenen Daten erhoben
                    oder verarbeitet, da sich die Plattform noch in der
                    Entwicklung befindet.
                </p>
                <p>
                    Sobald wir live gehen, werden wir eine detaillierte
                    Datenschutzerklärung bereitstellen, die alle Aspekte der
                    Datenerhebung, -verarbeitung und -speicherung abdeckt.
                </p>
                <p>
                    Wir legen großen Wert auf den Schutz deiner Daten und werden
                    sicherstellen, dass alle gesetzlichen Anforderungen
                    eingehalten werden.
                </p>
            </div>
        </section>
    );
}
