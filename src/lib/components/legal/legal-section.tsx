export default function LegalSection({
    label,
    title,
    children,
}: {
    label?: string;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <section className="grid gap-x-12 gap-y-6 border-b px-6 py-12 last:border-b-0 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-16">
            <div className="self-start md:sticky md:top-24">
                {label ? (
                    <p className="mb-2 text-xs tabular-nums text-zinc-600">
                        {label}
                    </p>
                ) : null}
                <h2 className="text-sm font-medium tracking-tight text-white text-balance">
                    {title}
                </h2>
            </div>
            <div className="max-w-2xl space-y-4 text-sm leading-7 text-zinc-400">
                {children}
            </div>
        </section>
    );
}
