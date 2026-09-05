import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./tailwind.css";
import FooterLink from "@/lib/components/ui/footer-link";
import Wordmark from "@/lib/components/ui/wordmark";
import { commit, operator, site } from "@/lib/site";

const inter = Inter({
    subsets: ["latin"],
    variable: "--font-inter",
    display: "swap",
});

export const metadata: Metadata = {
    metadataBase: new URL(site.url),
    title: {
        default: `${site.name} — KVM-Instanzen`,
        template: `%s — ${site.name}`,
    },
    description: `${site.tagline} ${site.description}`,
    openGraph: {
        type: "website",
        locale: "de_DE",
        siteName: site.name,
        url: site.url,
    },
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="de" className={inter.variable}>
            <body className="flex min-h-dvh flex-col bg-black font-sans text-white">
                <a
                    href="#content"
                    className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-6 focus:z-[100] focus:border focus:bg-black focus:px-4 focus:py-2 focus:text-sm"
                >
                    Zum Inhalt springen
                </a>

                <header className="site-header sticky top-0 z-50 border-b bg-black/80 backdrop-blur-md">
                    <div className="mx-auto flex h-16 w-full max-w-6xl items-center border-x px-6 md:px-10">
                        <Link
                            href="/"
                            className="group text-base font-semibold tracking-tight"
                        >
                            <Wordmark />
                        </Link>
                    </div>
                </header>

                <main id="content" className="flex grow flex-col">
                    <div className="mx-auto flex w-full max-w-6xl grow flex-col border-x">
                        {children}
                    </div>
                </main>

                <footer className="border-t select-none">
                    <div className="mx-auto w-full max-w-6xl border-x">
                        <div className="grid md:grid-cols-3">
                            <div className="space-y-4 p-6 md:p-10">
                                <h2 className="text-sm font-medium tracking-tight">
                                    <Wordmark />
                                </h2>
                                <p className="max-w-xs text-sm text-zinc-500">
                                    {site.tagline}
                                </p>
                            </div>

                            <div className="space-y-4 border-t p-6 md:border-t-0 md:border-l md:p-10">
                                <h2 className="text-sm font-medium tracking-tight">
                                    Kontakt
                                </h2>
                                <p className="text-sm text-zinc-500">
                                    {operator.name}
                                    <br />
                                    {operator.street}
                                    <br />
                                    {operator.city}
                                </p>
                                <a
                                    href={`mailto:${operator.email}`}
                                    className="block text-sm text-zinc-400 transition-colors hover:text-white"
                                >
                                    {operator.email}
                                </a>
                            </div>

                            <div className="space-y-4 border-t p-6 md:border-t-0 md:border-l md:p-10">
                                <h2 className="text-sm font-medium tracking-tight">
                                    Rechtliches
                                </h2>
                                <ul className="space-y-2">
                                    <FooterLink href="/legal">
                                        Impressum
                                    </FooterLink>
                                    <FooterLink href="/privacy">
                                        Datenschutz
                                    </FooterLink>
                                    <FooterLink href="/terms">AGB</FooterLink>
                                </ul>
                            </div>
                        </div>

                        <div className="border-t px-6 py-6 md:px-10">
                            <p className="font-mono text-xs text-zinc-600">
                                commit {commit}
                            </p>
                        </div>
                    </div>
                </footer>
            </body>
        </html>
    );
}
