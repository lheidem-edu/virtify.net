import Link from "next/link";

export default function NotFound() {
    return (
        <section className="grow px-6 py-24 md:px-10 md:py-36">
            <p className="text-xs tracking-[0.2em] tabular-nums text-zinc-600">
                404
            </p>
            <h2 className="mt-8 text-4xl font-semibold tracking-tight sm:text-5xl">
                Seite nicht gefunden
            </h2>
            <p className="mt-6 max-w-md text-zinc-500">
                Die angeforderte Seite existiert nicht oder wurde verschoben.
            </p>
            <Link
                href="/"
                className="mt-10 inline-block border px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white hover:bg-white hover:text-black"
            >
                Zur Startseite
            </Link>
        </section>
    );
}
