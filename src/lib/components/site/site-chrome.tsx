import { ArrowRight, CircleUser } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import FooterLink from "@/lib/components/ui/footer-link";
import Wordmark from "@/lib/components/ui/wordmark";
import { loadSettings } from "@/lib/settings";
import { commit } from "@/lib/site";

async function SiteHeader() {
    const { site } = await loadSettings();

    return (
        <header className="site-header sticky top-0 z-50 border-b bg-black/80 backdrop-blur-md">
            <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between border-x px-6 md:px-10">
                <Link
                    href="/"
                    className="group text-base font-semibold tracking-tight"
                >
                    <Wordmark name={site.name} />
                </Link>

                <Button
                    nativeButton={false}
                    render={<Link href="/account" />}
                    variant="outline"
                    size="sm"
                    className="group/link gap-2"
                >
                    <CircleUser className="size-4 text-muted-foreground transition-colors group-hover/link:text-current" />
                    Kundenbereich
                    <ArrowRight className="size-3.5 -translate-x-0.5 opacity-0 transition-all group-hover/link:translate-x-0 group-hover/link:opacity-100" />
                </Button>
            </div>
        </header>
    );
}

async function SiteFooter() {
    const { operator, site } = await loadSettings();

    return (
        <footer className="border-t select-none">
            <div className="mx-auto w-full max-w-6xl border-x">
                <div className="grid md:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-4 p-6 md:p-10">
                        <h2 className="text-sm font-medium tracking-tight">
                            <Wordmark name={site.name} />
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

                    <div className="space-y-4 border-t p-6 md:border-l md:p-10 lg:border-t-0">
                        <h2 className="text-sm font-medium tracking-tight">
                            Konto
                        </h2>
                        <ul className="space-y-2">
                            <FooterLink href="/account/login">
                                Anmelden
                            </FooterLink>
                            <FooterLink href="/account/register">
                                Konto anlegen
                            </FooterLink>
                        </ul>
                    </div>

                    <div className="space-y-4 border-t p-6 md:border-t-0 md:border-l md:p-10">
                        <h2 className="text-sm font-medium tracking-tight">
                            Rechtliches
                        </h2>
                        <ul className="space-y-2">
                            <FooterLink href="/legal">Impressum</FooterLink>
                            <FooterLink href="/privacy">Datenschutz</FooterLink>
                            <FooterLink href="/terms">AGB</FooterLink>
                            <FooterLink href="/cancellation">
                                Verträge hier kündigen
                            </FooterLink>
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
    );
}

/** The public site's frame: sticky header, railed content column, footer. */
export default function SiteChrome({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <>
            <a
                href="#content"
                className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-6 focus:z-[100] focus:border focus:bg-black focus:px-4 focus:py-2 focus:text-sm"
            >
                Zum Inhalt springen
            </a>

            <SiteHeader />

            <main id="content" className="flex grow flex-col">
                <div className="mx-auto flex w-full max-w-6xl grow flex-col border-x">
                    {children}
                </div>
            </main>

            <SiteFooter />
        </>
    );
}
