"use client";

import {
    CreditCard,
    FileSignature,
    FileText,
    KeyRound,
    LayoutDashboard,
    LifeBuoy,
    LogOut,
    Receipt,
    Repeat,
    Scale,
    Server,
    Settings,
    Shield,
    ShoppingCart,
    User,
    UserCog,
    Users,
    Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
    LanguageSwitcher,
    ThemeSwitcher,
} from "@/components/client/preferences";
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
import type { Locale } from "@/i18n/locale";
import { authClient } from "@/lib/auth-client";
import type { Theme } from "@/lib/theme";

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
    "shopping-cart": ShoppingCart,
    repeat: Repeat,
    wallet: Wallet,
    "life-buoy": LifeBuoy,
    server: Server,
};

function NavGroup({
    label,
    entries,
    pathname,
    labelFor,
}: {
    label: string;
    entries: readonly NavEntry[];
    pathname: string;
    /**
     * The nav structure is shared with the admin shell and its labels are
     * German constants; in the portal they go through the catalogue instead,
     * keyed on the last segment of the href. Falling back to the constant
     * keeps a new entry working before its key exists.
     */
    labelFor: (entry: NavEntry) => string;
}) {
    return (
        <SidebarGroup>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {entries.map((entry) => {
                        const Icon = ICONS[entry.icon] ?? FileText;
                        const text = labelFor(entry);
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
                                    tooltip={text}
                                    render={<Link href={entry.href} />}
                                >
                                    <Icon />
                                    <span>{text}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        );
                    })}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
    );
}

const NAV_KEY: Record<string, string> = {
    "/client": "overview",
    "/client/orders": "orders",
    "/client/subscriptions": "subscriptions",
    "/client/services": "services",
    "/client/contracts": "contracts",
    "/client/offers": "offers",
    "/client/invoices": "invoices",
    "/client/payment-methods": "paymentMethods",
    "/client/credit": "credit",
    "/client/tickets": "tickets",
    "/client/profile": "profile",
    "/client/api-keys": "apiKeys",
    "/client/security": "security",
    "/client/privacy": "privacy",
};

export default function ClientSidebar({
    email,
    locale,
    theme,
}: {
    email: string;
    locale: Locale;
    theme: Theme;
}) {
    const pathname = usePathname();
    const router = useRouter();
    const [signingOut, setSigningOut] = useState(false);
    const t = useTranslations("portal.nav");

    const labelFor = (entry: NavEntry) => {
        const key = NAV_KEY[entry.href];

        return key ? t(key as never) : entry.label;
    };

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
                    label={t("account")}
                    entries={ACCOUNT_NAV}
                    pathname={pathname}
                    labelFor={labelFor}
                />
                <NavGroup
                    label={t("settings")}
                    entries={ACCOUNT_SETTINGS_NAV}
                    pathname={pathname}
                    labelFor={labelFor}
                />
            </SidebarContent>

            <SidebarFooter className="border-t">
                <LanguageSwitcher current={locale} />
                <ThemeSwitcher current={theme} />

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
                            tooltip={t("signOut")}
                            disabled={signingOut}
                            onClick={async () => {
                                setSigningOut(true);
                                await authClient.signOut();
                                router.push("/client/login");
                                router.refresh();
                            }}
                        >
                            <LogOut />
                            <span>{t("signOut")}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>

            <SidebarRail />
        </Sidebar>
    );
}
