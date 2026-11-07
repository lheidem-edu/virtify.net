"use client";

import {
    CreditCard,
    FileSignature,
    FileText,
    KeyRound,
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
    ACCOUNT_NAV,
    ACCOUNT_SETTINGS_NAV,
    type NavEntry,
} from "@/components/shared/nav";
import Wordmark from "@/components/shared/wordmark";
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
import { authClient } from "@/lib/auth-client";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    "layout-dashboard": LayoutDashboard,
    "file-text": FileText,
    "file-signature": FileSignature,
    receipt: Receipt,
    "credit-card": CreditCard,
    scale: Scale,
    settings: Settings,
    user: User,
    "user-cog": UserCog,
    shield: Shield,
    users: Users,
    key: KeyRound,
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
                        // Exact match for the index route, prefix match for
                        // the rest, so a detail page keeps its parent lit.
                        const active =
                            entry.href === "/client"
                                ? pathname === "/client"
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

export default function ClientSidebar({ email }: { email: string }) {
    const pathname = usePathname();
    const router = useRouter();
    const [signingOut, setSigningOut] = useState(false);

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="border-b">
                <Link
                    href="/"
                    className="group flex h-8 items-center px-2 text-sm font-semibold tracking-tight group-data-[collapsible=icon]:justify-center"
                >
                    <span className="group-data-[collapsible=icon]:hidden">
                        <Wordmark />
                    </span>
                    <span className="hidden group-data-[collapsible=icon]:inline">
                        v
                    </span>
                </Link>
            </SidebarHeader>

            <SidebarContent>
                <NavGroup
                    label="Konto"
                    entries={ACCOUNT_NAV}
                    pathname={pathname}
                />
                <NavGroup
                    label="Einstellungen"
                    entries={ACCOUNT_SETTINGS_NAV}
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
                                await authClient.signOut();
                                router.push("/client/login");
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
