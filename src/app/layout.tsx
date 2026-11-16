import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import "./tailwind.css";
import {
    DEFAULT_THEME,
    rendersDark,
    THEME_COOKIE,
    THEME_SCRIPT,
    toTheme,
} from "@/lib/theme";
import { loadSettings } from "@/server/settings";

const inter = Inter({
    subsets: ["latin"],
    variable: "--font-inter",
    display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
    const { site } = await loadSettings();

    return {
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
}

/**
 * Root shell only. The marketing frame lives in the (site) group and the
 * dashboard brings its own, so the account area is not wrapped in the
 * public header and footer.
 *
 * Phase 9 added two things to it: the resolved locale, which decides `lang`
 * and what the client provider hands down, and the theme, which decides
 * whether `dark` is on the root element before the first paint.
 */
export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const locale = await getLocale();
    const theme = toTheme(
        (await cookies()).get(THEME_COOKIE)?.value ?? DEFAULT_THEME,
    );
    const dark = rendersDark(theme);

    return (
        <html
            lang={locale}
            data-theme={theme}
            className={`${dark ? "dark " : ""}${inter.variable}`}
            // Only honoured for `system`, where the script below overrides it;
            // for the other two it is what the browser renders form controls
            // and scrollbars with.
            style={{ colorScheme: dark ? "dark" : "light" }}
            // The inline script writes `class` and `style` on this element
            // before React hydrates, which React would otherwise report as a
            // mismatch on every `system` load.
            suppressHydrationWarning
        >
            <head>
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a
                    module constant with nothing interpolated into it; see
                    THEME_SCRIPT. It has to be inline and synchronous, because
                    a separate file is a round trip in front of the paint it
                    exists to make correct. */}
                <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
            </head>
            <body className="flex min-h-dvh flex-col">
                <NextIntlClientProvider>{children}</NextIntlClientProvider>
            </body>
        </html>
    );
}
