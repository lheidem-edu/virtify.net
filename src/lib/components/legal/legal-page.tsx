import { legalUpdated } from "@/lib/site";

export default function LegalPage({
    eyebrow = "Rechtliches",
    title,
    intro,
    children,
}: {
    eyebrow?: string;
    title: string;
    intro?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <article>
            <header className="border-b px-6 py-20 md:px-10 md:py-28">
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                    {eyebrow}
                </p>
                <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                    {title}
                </h1>
                {intro ? (
                    <div className="mt-8 max-w-2xl text-sm leading-7 text-zinc-400">
                        {intro}
                    </div>
                ) : null}
                <p className="mt-10 text-xs text-zinc-600">
                    Stand: {legalUpdated}
                </p>
            </header>
            {children}
        </article>
    );
}
