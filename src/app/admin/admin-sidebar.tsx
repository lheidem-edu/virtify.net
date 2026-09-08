"use client";

import {
    FileSignature,
    FileText,
    LayoutDashboard,
    LogOut,
    Receipt,
    Scale,
    Settings,
    Shield,
    User,
    UserCog,
    Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from "@/components/ui/sidebar";
import {
    ADMIN_NAV,
    ADMIN_SETTINGS_NAV,
    type NavEntry,
} from "@/lib/components/account/nav";
import Wordmark from "@/lib/components/ui/wordmark";
import { staffAuthClient } from "@/lib/staff-auth-client";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    "layout-dashboard": LayoutDashboard,
    "file-text": FileText,
    "file-signature": FileSignature,
    receipt: Receipt,
    scale: Scale,
    settings: Settings,
    shield: Shield,
    "user-cog": UserCog,
    users: Users,
};

function NavGroup({
    label,
    entries,
    pathname,
}: {
    label: string;
    entries: readonly NavEntry[];
    pathname: string;
}) {
    return (
        <SidebarGroup>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {entries.map((entry) => {
                        const Icon = ICONS[entry.icon] ?? FileText;
                        const active =
                            entry.href === "/admin"
                                ? pathname === "/admin"
                                : pathname.startsWith(entry.href);

                        return (
                            <SidebarMenuItem key={entry.href}>
                                <SidebarMenuButton
                                    isActive={active}
                                    tooltip={entry.label}
                                    render={<Link href={entry.href} />}
                                >
                                    <Icon />
                                    <span>{entry.label}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        );
                    })}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
    );
}

export default function AdminSidebar({ email }: { email: string }) {
    const pathname = usePathname();
    const router = useRouter();
    const [signingOut, setSigningOut] = useState(false);

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="border-b">
                <Link
                    href="/"
                    className="group flex h-8 items-center gap-2 px-2 text-sm font-semibold tracking-tight group-data-[collapsible=icon]:justify-center"
                >
                    <span className="group-data-[collapsible=icon]:hidden">
                        <Wordmark />
                    </span>
                    <span className="hidden group-data-[collapsible=icon]:inline">
                        v
                    </span>
                    <span className="text-xs font-normal text-muted-foreground group-data-[collapsible=icon]:hidden">
                        Verwaltung
                    </span>
                </Link>
            </SidebarHeader>

            <SidebarContent>
                <NavGroup
                    label="Verwaltung"
                    entries={ADMIN_NAV}
                    pathname={pathname}
                />
                <NavGroup
                    label="Zugang"
                    entries={ADMIN_SETTINGS_NAV}
                    pathname={pathname}
                />
            </SidebarContent>

            <SidebarFooter className="border-t">
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            tooltip={email}
                            className="pointer-events-none"
                        >
                            <User />
                            <span className="truncate">{email}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            tooltip="Abmelden"
                            disabled={signingOut}
                            onClick={async () => {
                                setSigningOut(true);
                                await staffAuthClient.signOut();
                                router.push("/admin/login");
                                router.refresh();
                            }}
                        >
                            <LogOut />
                            <span>Abmelden</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>

            <SidebarRail />
        </Sidebar>
    );
}
