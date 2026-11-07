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
import { getCurrentCustomer } from "@/server/customers/current";
import { listOrders } from "@/server/orders/repository";

/**
 * The customer's own orders. Scoped by `getCurrentCustomer()` and by the
 * query behind `listOrders`, which puts the ownership rule into the SQL —
 * no id from the request reaches either.
 */
export default async function Page() {
    const { customer } = await getCurrentCustomer();
    const page = await listOrders(customer.id, false, { limit: 100 });

    return (
        <>
            <PageHeader
                title="Bestellungen"
                intro="Was bestellt wurde, was daraus geworden ist und welche Rechnung dazugehört."
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {page.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Es liegt noch keine Bestellung vor.{" "}
                        <Link
                            href="/products"
                            className="underline underline-offset-4"
                        >
                            Produkte ansehen
                        </Link>
                    </p>
                ) : (
                    <ul className="space-y-3">
                        {page.rows.map((row) => (
                            <li key={row.id}>
                                <Link
                                    href={`/client/orders/${row.id}`}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4 transition-colors hover:border-ring"
                                >
                                    <span>
                                        <span className="font-mono text-sm">
                                            {row.number}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
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
