import Link from "next/link";
import { Button } from "@/components/ui/button";
import SiteChrome from "@/lib/components/site/site-chrome";

/** Unmatched routes render inside the public frame, wherever they occurred. */
export default function NotFound() {
    return (
        <SiteChrome>
            <section className="grow px-6 py-24 md:px-10 md:py-36">
                <p className="text-xs tracking-[0.2em] tabular-nums text-zinc-600">
                    404
                </p>
                <h2 className="mt-8 text-4xl font-semibold tracking-tight sm:text-5xl">
                    Seite nicht gefunden
                </h2>
                <p className="mt-6 max-w-md text-zinc-500">
                    Die angeforderte Seite existiert nicht oder wurde
                    verschoben.
                </p>
                <Button
                    nativeButton={false}
                    render={<Link href="/" />}
                    variant="outline"
                    size="lg"
                    className="mt-10"
                >
                    Zur Startseite
                </Button>
            </section>
        </SiteChrome>
    );
}
