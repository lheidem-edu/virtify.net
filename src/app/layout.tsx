"use client";

import Link from "next/link";
import "./tailwind.css";
import FooterLink from "@/lib/components/ui/footer-link";

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body className={`min-h-dvh flex flex-col bg-black text-white`}>
                <header className="top-0 sticky backdrop-blur-lg border-b px-4 border-zinc-600/40">
                    <div className="max-w-7xl mx-auto flex p-4 items-center justify-between">
                        <h1 className="tracking-tight font-bold text-2xl">
                            <Link href="/">Virtify</Link>
                        </h1>

                        <a
                            href="/admin"
                            className="text-sm text-zinc-800 px-3 py-2 bg-white hover:bg-zinc-200 rounded-lg"
                        >
                            Administration
                        </a>
                    </div>
                </header>

                <main className="grow flex flex-col">
                    <div className="max-w-7xl mx-auto grow w-full px-6 py-18">
                        {children}
                    </div>
                </main>

                <footer className="border-t border-zinc-600/40 select-none">
                    <div className="max-w-7xl mx-auto">
                        <div className="grid grid-cols-1 lg:grid-cols-4 gap-12 px-6 py-18">
                            <div className="space-y-4 col-span-1 lg:col-span-2">
                                <h2 className="font-bold tracking-tight text-sm">
                                    Virtify
                                </h2>
                                <p className="text-zinc-400 text-sm">
                                    Vollständig automatisiertes, skalierbares
                                    und zuverlässiges Hosting.
                                </p>
                            </div>
                            <div className="space-y-4">
                                <h2 className="font-bold tracking-tight text-sm">
                                    Weitere Informationen
                                </h2>
                                <ul className="text-zinc-400 space-y-2">
                                    <FooterLink
                                        href="https://bgp.tools/as/207196"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        Netzwerk auf bgp.tools
                                    </FooterLink>
                                    <FooterLink
                                        href="https://www.peeringdb.com/net/39520"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        Netzwerk auf peeringdb.com
                                    </FooterLink>
                                </ul>
                            </div>
                            <div className="space-y-4">
                                <h2 className="font-bold tracking-tight text-sm">
                                    Rechtliches
                                </h2>
                                <ul className="text-zinc-400 space-y-2">
                                    <FooterLink href="/legal/">
                                        Impressum
                                    </FooterLink>
                                    <FooterLink href="/privacy/">
                                        Datenschutz
                                    </FooterLink>
                                    <FooterLink href="/terms/">
                                        Allgemeine Geschäftsbedingungen (AGB)
                                    </FooterLink>
                                </ul>
                            </div>
                        </div>
                        <div className="border-t border-zinc-600/40 flex items-center justify-center px-6 py-18">
                            <p className="text-zinc-600 text-sm">
                                Ein Projekt von Luca Heidemann. Alle Rechte
                                vorbehalten.
                            </p>
                        </div>
                    </div>
                </footer>
            </body>
        </html>
    );
}
