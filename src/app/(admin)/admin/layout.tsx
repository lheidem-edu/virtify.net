import type { Metadata } from "next";

/**
 * Nothing but the title and the noindex for everything under /admin — the
 * sign-in and the two-factor setup are as private as the pages behind them.
 * The shell itself is one level down, in the (shell) group, so those two can
 * render without it.
 */
export const metadata: Metadata = {
    title: "Verwaltung",
    robots: { index: false, follow: false },
};

export default function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return children;
}
