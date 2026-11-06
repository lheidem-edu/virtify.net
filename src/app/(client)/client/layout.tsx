import type { Metadata } from "next";
import ClientSidebar from "@/components/client/client-sidebar";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";
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

    // Sign-in, registration and password recovery live under /account too but
    // must render without the shell — there is nothing to navigate yet.
    if (!session) {
        return <>{children}</>;
    }

    return (
        <SidebarProvider>
            <ClientSidebar email={session.user.email} />
            <SidebarInset>
                <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
                    <SidebarTrigger />
                </header>
                <div className="flex flex-1 flex-col">{children}</div>
            </SidebarInset>
        </SidebarProvider>
    );
}
