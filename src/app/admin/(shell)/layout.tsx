import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { requireStaff } from "@/lib/staff-session";
import AdminSidebar from "./admin-sidebar";

/**
 * The shell around Verwaltung. It is a route group rather than /admin itself
 * because the three pages that are still the door — the sign-in, the
 * set-password link and the two-factor setup — must render without it: a
 * sidebar full of links you cannot follow yet is not navigation, it is a
 * tease. They live outside (shell) and answer under the same /admin paths.
 */

export default async function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Every page behind here guards itself as well; this one makes sure the
    // shell is never drawn for someone who is not through the door.
    const session = await requireStaff();

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
