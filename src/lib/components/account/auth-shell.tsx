import Link from "next/link";
import Wordmark from "@/lib/components/ui/wordmark";

const LEGAL = [
    { href: "/legal", label: "Impressum" },
    { href: "/privacy", label: "Datenschutz" },
    { href: "/terms", label: "AGB" },
];

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
        <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
            <div className="w-full max-w-sm">
                <Link
                    href="/"
                    className="group inline-block text-lg font-semibold tracking-tight"
                >
                    <Wordmark />
                </Link>

                <h1 className="mt-10 text-2xl font-semibold tracking-tight text-balance">
                    {title}
                </h1>
                {intro ? (
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        {intro}
                    </p>
                ) : null}

                <div className="mt-8 rounded-lg border p-6">{children}</div>

                {footer ? (
                    <div className="mt-6 text-sm text-muted-foreground">
                        {footer}
                    </div>
                ) : null}

                <div className="mt-12 flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-6 text-xs text-zinc-600">
                    <Link
                        href="/"
                        className="transition-colors hover:text-zinc-400"
                    >
                        Zur Website
                    </Link>
                    {LEGAL.map((entry) => (
                        <Link
                            key={entry.href}
                            href={entry.href}
                            className="transition-colors hover:text-zinc-400"
                        >
                            {entry.label}
                        </Link>
                    ))}
                </div>
            </div>
        </div>
    );
}
