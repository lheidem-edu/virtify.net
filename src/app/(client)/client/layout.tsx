import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import ClientSidebar from "@/components/client/client-sidebar";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { toLocale } from "@/i18n/locale";
import { THEME_COOKIE, toTheme } from "@/lib/theme";
import { getSession } from "@/server/auth/session";

export const metadata: Metadata = {
    title: "Konto",
    robots: { index: false, follow: false },
};

export default async function AccountLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await getSession();
    const locale = toLocale(await getLocale());
    const theme = toTheme((await cookies()).get(THEME_COOKIE)?.value);

    // Sign-in, registration and password recovery live under /client too but
    // must render without the shell — there is nothing to navigate yet.
    if (!session) {
        return <>{children}</>;
    }

    return (
        <SidebarProvider>
            <ClientSidebar
                email={session.user.email}
                locale={locale}
                theme={theme}
            />
            <SidebarInset>
                <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
                    <SidebarTrigger />
                </header>
                <div className="flex flex-1 flex-col">{children}</div>
            </SidebarInset>
        </SidebarProvider>
    );
}
