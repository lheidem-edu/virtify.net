export default function NotFound() {
    return (
        <section className="flex flex-col items-center justify-center text-center gap-4">
            <h2 className="text-4xl font-extrabold tracking-tight text-white">
                Seite nicht gefunden
            </h2>
            <p className="text-zinc-400">
                Die angeforderte Seite existiert nicht.
            </p>
        </section>
    );
}
