import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/lib/auth-session";
import SignOutButton from "./sign-out-button";

export const metadata: Metadata = {
    title: "Kundenbereich",
    robots: { index: false, follow: false },
};

const NAV = [
    { href: "/customer", label: "Übersicht" },
    { href: "/customer/profile", label: "Stammdaten" },
    { href: "/customer/security", label: "Sicherheit" },
];

export default async function CustomerLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await getSession();

    return (
        <>
            {session ? (
                <div className="flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center md:justify-between md:px-10">
                    <nav className="flex flex-wrap gap-x-6 gap-y-2">
                        {NAV.map((entry) => (
                            <Link
                                key={entry.href}
                                href={entry.href}
                                className="text-sm text-zinc-400 transition-colors hover:text-white"
                            >
                                {entry.label}
                            </Link>
                        ))}
                    </nav>
                    <div className="flex items-center gap-4 text-sm text-zinc-500">
                        <span className="truncate">{session.user.email}</span>
                        <SignOutButton />
                    </div>
                </div>
            ) : null}
            {children}
        </>
    );
}
