/**
 * Sidebar structure. The customer area and Verwaltung are two different
 * shells with two different sessions — a customer never sees the admin nav
 * because they cannot hold a staff session at all — and every route behind
 * either checks again server-side. Hiding a link is a convenience, never the
 * access control.
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
    { href: "/admin/customers", label: "Kunden", icon: "users" },
    { href: "/admin/contracts", label: "Verträge", icon: "file-text" },
    { href: "/admin/offers", label: "Angebote", icon: "file-signature" },
    { href: "/admin/invoices", label: "Rechnungen", icon: "receipt" },
    { href: "/admin/legal", label: "Rechtstexte", icon: "scale" },
    { href: "/admin/settings", label: "Einstellungen", icon: "settings" },
] as const;

/** The employee's own account, not the business. */
export const ADMIN_SETTINGS_NAV = [
    { href: "/admin/staff", label: "Mitarbeiter", icon: "user-cog" },
    { href: "/admin/two-factor", label: "Sicherheit", icon: "shield" },
] as const;

export type NavEntry = { href: string; label: string; icon: string };
