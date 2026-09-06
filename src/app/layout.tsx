import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./tailwind.css";
import { site } from "@/lib/site";

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

/**
 * Root shell only. The marketing frame lives in the (site) group and the
 * dashboard brings its own, so the account area is not wrapped in the
 * public header and footer.
 */
export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="de" className={`dark ${inter.variable}`}>
            <body className="flex min-h-dvh flex-col">{children}</body>
        </html>
    );
}
