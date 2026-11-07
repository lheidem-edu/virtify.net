import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import {
    formatDate,
    formatPrice,
    ORDER_STATUS_LABEL,
    ORDER_STATUS_TONE,
    PAYMENT_OPTION_LABEL,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { ANY_CUSTOMER, listOrders } from "@/server/orders/repository";

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; q?: string }>;
}) {
    await requirePermission("orders.read");

    const { status, q } = await searchParams;
    const filter = (["pending", "active", "cancelled", "fraud"] as const).find(
        (entry) => entry === status,
    );

    const page = await listOrders(ANY_CUSTOMER, true, {
        status: filter,
        q,
        limit: 100,
    });

    return (
        <>
            <PageHeader
                title="Bestellungen"
                intro="Was bestellt wurde, und was daraus geworden ist. Eine offene Bestellung wartet auf eine Entscheidung — bis dahin wird nichts bereitgestellt."
            />

            <div className="space-y-6 px-6 py-10 md:px-10 md:py-12">
                <nav className="flex flex-wrap gap-2 text-xs">
                    {[
                        { href: "/admin/orders", label: "Alle" },
                        {
                            href: "/admin/orders?status=pending",
                            label: "Offen",
                        },
                        {
                            href: "/admin/orders?status=active",
                            label: "Angenommen",
                        },
                        {
                            href: "/admin/orders?status=cancelled",
                            label: "Storniert",
                        },
                        { href: "/admin/orders?status=fraud", label: "Betrug" },
                    ].map((entry) => (
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
                    <p className="text-sm text-muted-foreground">
                        Keine Bestellungen.
                    </p>
                ) : (
                    <ul className="space-y-3">
                        {page.rows.map((row) => (
                            <li key={row.id}>
                                <Link
                                    href={`/admin/orders/${row.id}`}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4 transition-colors hover:border-ring"
                                >
                                    <span>
                                        <span className="font-mono text-sm">
                                            {row.number}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                            {row.customerName} (
                                            {row.customerNumber}) ·{" "}
                                            {formatDate(row.placedAt)} ·{" "}
                                            {
                                                PAYMENT_OPTION_LABEL[
                                                    row.paymentOption
                                                ]
                                            }
                                        </span>
                                    </span>
                                    <span className="flex items-center gap-4">
                                        <span className="font-mono text-sm">
                                            {formatPrice(row.grossCents)}
                                        </span>
                                        <StatusBadge
                                            label={
                                                ORDER_STATUS_LABEL[row.status]
                                            }
                                            tone={ORDER_STATUS_TONE[row.status]}
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
