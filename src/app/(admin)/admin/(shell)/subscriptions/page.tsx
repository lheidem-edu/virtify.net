import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import type { SubscriptionStatus } from "@/db/schema";
import {
    formatDate,
    formatPrice,
    SUBSCRIPTION_STATUS_LABEL,
    SUBSCRIPTION_STATUS_TONE,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import {
    ANY_CUSTOMER,
    listSubscriptions,
} from "@/server/subscriptions/repository";
import RunBillingButton from "./run-billing-button";

const FILTERS: { href: string; label: string }[] = [
    { href: "/admin/subscriptions", label: "Alle" },
    { href: "/admin/subscriptions?status=active", label: "Aktiv" },
    { href: "/admin/subscriptions?status=trialing", label: "Testphase" },
    { href: "/admin/subscriptions?status=past_due", label: "Überfällig" },
    { href: "/admin/subscriptions?status=paused", label: "Pausiert" },
    { href: "/admin/subscriptions?status=cancelled", label: "Gekündigt" },
    { href: "/admin/subscriptions?status=ended", label: "Beendet" },
];

const STATUSES: SubscriptionStatus[] = [
    "trialing",
    "active",
    "past_due",
    "paused",
    "cancelled",
    "ended",
];

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; q?: string }>;
}) {
    await requirePermission("subscriptions.read");

    const { status, q } = await searchParams;
    const filter = STATUSES.find((entry) => entry === status);

    const page = await listSubscriptions(ANY_CUSTOMER, true, {
        status: filter,
        q,
        limit: 100,
    });

    return (
        <>
            <PageHeader
                title="Abos"
                intro="Die laufenden Verträge: was wann berechnet wird, was überfällig ist und was zum Ende des Zeitraums ausläuft. Der tägliche Lauf stellt die Verlängerungen; hier siehst du, was er vorhat."
                action={<RunBillingButton />}
            />

            <div className="space-y-6 px-6 py-10 md:px-10 md:py-12">
                <nav className="flex flex-wrap gap-2 text-xs">
                    {FILTERS.map((entry) => (
                        <Link
                            key={entry.href}
                            href={entry.href}
                            className="rounded-md border px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {entry.label}
                        </Link>
                    ))}
                </nav>

                {page.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Keine Abos.</p>
                ) : (
                    <ul className="space-y-3">
                        {page.rows.map((row) => (
                            <li key={row.id}>
                                <Link
                                    href={`/admin/subscriptions/${row.id}`}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4 transition-colors hover:border-ring"
                                >
                                    <span>
                                        <span className="text-sm">
                                            {row.label}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                            {row.customerName} (
                                            {row.customerNumber}) ·{" "}
                                            {row.nextBillingAt
                                                ? `nächste Abrechnung ${formatDate(row.nextBillingAt)}`
                                                : "keine weitere Abrechnung"}
                                            {row.cancelAtPeriodEnd
                                                ? " · gekündigt zum Ende"
                                                : ""}
                                        </span>
                                    </span>
                                    <span className="flex items-center gap-4">
                                        <span className="font-mono text-sm">
                                            {formatPrice(row.periodGrossCents)}
                                        </span>
                                        <StatusBadge
                                            label={
                                                SUBSCRIPTION_STATUS_LABEL[
                                                    row.status
                                                ]
                                            }
                                            tone={
                                                SUBSCRIPTION_STATUS_TONE[
                                                    row.status
                                                ]
                                            }
                                        />
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
