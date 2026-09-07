/**
 * Sidebar structure. The admin group is only rendered for admins, and every
 * route behind it checks the role again server-side — hiding a link is a
 * convenience, never the access control.
 */
export const ACCOUNT_NAV = [
    { href: "/account", label: "Übersicht", icon: "layout-dashboard" },
    { href: "/account/contracts", label: "Verträge", icon: "file-text" },
    { href: "/account/offers", label: "Angebote", icon: "file-signature" },
    { href: "/account/invoices", label: "Rechnungen", icon: "receipt" },
    {
        href: "/account/payment-methods",
        label: "Zahlungsmittel",
        icon: "credit-card",
    },
] as const;

export const ACCOUNT_SETTINGS_NAV = [
    { href: "/account/profile", label: "Stammdaten", icon: "user" },
    { href: "/account/security", label: "Sicherheit", icon: "shield" },
] as const;

export const ADMIN_NAV = [
    { href: "/account/admin/customers", label: "Kunden", icon: "users" },
    { href: "/account/admin/contracts", label: "Verträge", icon: "file-text" },
    {
        href: "/account/admin/offers",
        label: "Angebote",
        icon: "file-signature",
    },
    { href: "/account/admin/invoices", label: "Rechnungen", icon: "receipt" },
    { href: "/account/admin/legal", label: "Rechtstexte", icon: "scale" },
    {
        href: "/account/admin/settings",
        label: "Einstellungen",
        icon: "settings",
    },
] as const;

export type NavEntry = { href: string; label: string; icon: string };
