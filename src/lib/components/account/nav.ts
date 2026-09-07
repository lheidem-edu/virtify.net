/**
 * Sidebar structure. The admin group is only rendered for admins, and every
 * route behind it checks the role again server-side — hiding a link is a
 * convenience, never the access control.
 *
 * A customer and an employee see two different sidebars. An employee has no
 * contracts, no invoices and no Stammdaten — not none yet, none ever — so
 * those entries are absent rather than empty, and the pages behind them
 * answer with a 404.
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

/** What is left of the customer nav for an employee. */
export const EMPLOYEE_NAV = [
    { href: "/account", label: "Übersicht", icon: "layout-dashboard" },
] as const;

export const EMPLOYEE_SETTINGS_NAV = [
    { href: "/account/security", label: "Sicherheit", icon: "shield" },
] as const;

export const ADMIN_NAV = [
    { href: "/account/admin/customers", label: "Kunden", icon: "users" },
    { href: "/account/admin/staff", label: "Mitarbeiter", icon: "user-cog" },
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
