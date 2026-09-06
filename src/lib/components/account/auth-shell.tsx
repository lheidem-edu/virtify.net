export default function AuthShell({
    title,
    intro,
    children,
    footer,
}: {
    title: string;
    intro?: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
}) {
    return (
        <section className="grow px-6 py-20 md:px-10 md:py-28">
            <div className="max-w-sm">
                <h1 className="text-3xl font-semibold tracking-tight text-balance">
                    {title}
                </h1>
                {intro ? (
                    <p className="mt-4 text-sm leading-7 text-zinc-400">
                        {intro}
                    </p>
                ) : null}
                <div className="mt-10">{children}</div>
                {footer ? (
                    <div className="mt-8 text-sm text-zinc-500">{footer}</div>
                ) : null}
            </div>
        </section>
    );
}
