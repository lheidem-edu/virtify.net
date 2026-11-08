import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import {
    formatDate,
    formatPrice,
    SUBSCRIPTION_STATUS_LABEL,
    SUBSCRIPTION_STATUS_TONE,
} from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { listSubscriptions } from "@/server/subscriptions/repository";

export default async function Page() {
    const { customer } = await getCurrentCustomer();
    const page = await listSubscriptions(customer.id, false, { limit: 100 });

    return (
        <>
            <PageHeader
                title="Abos"
                intro="Deine laufenden Verträge: was wann abgerechnet wird, und was du daran ändern kannst."
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {page.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Du hast noch kein Abo.
                    </p>
                ) : (
                    <ul className="space-y-3">
                        {page.rows.map((row) => (
                            <li key={row.id}>
                                <Link
                                    href={`/client/subscriptions/${row.id}`}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4 transition-colors hover:border-ring"
                                >
                                    <span>
                                        <span className="text-sm">
                                            {row.label}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                            {row.cancelAtPeriodEnd
                                                ? `endet am ${formatDate(row.currentPeriodEnd)}`
                                                : row.nextBillingAt
                                                  ? `nächste Abrechnung ${formatDate(row.nextBillingAt)}`
                                                  : "keine weitere Abrechnung"}
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
