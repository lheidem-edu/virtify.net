import type { Metadata } from "next";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { getStaffSession } from "@/lib/staff-session";
import AdminSidebar from "./admin-sidebar";

export const metadata: Metadata = {
    title: "Verwaltung",
    robots: { index: false, follow: false },
};

export default async function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await getStaffSession();

    // The sign-in and the two-factor pages live under /admin too and must
    // render without the shell — there is nothing to navigate yet. Every page
    // behind the shell checks the session again for itself.
    if (!session) {
        return <>{children}</>;
    }

    return (
        <SidebarProvider>
            <AdminSidebar email={session.user.email} />
            <SidebarInset>
                <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
                    <SidebarTrigger />
                </header>
                <div className="flex flex-1 flex-col">{children}</div>
            </SidebarInset>
        </SidebarProvider>
    );
}
