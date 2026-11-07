import Link from "next/link";
import { notFound } from "next/navigation";
import OrderDetail from "@/components/shared/order-detail";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import {
    formatPrice,
    ORDER_STATUS_LABEL,
    ORDER_STATUS_TONE,
} from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { loadOrder } from "@/server/orders/repository";

/**
 * One of the customer's orders — and the page the checkout lands on.
 *
 * The id comes from the URL, so the loader is handed the account from the
 * session and refuses anything else. An order of somebody else's is 404, not
 * 403: 403 would confirm that the id exists.
 */
export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    const { customer } = await getCurrentCustomer();
    const loaded = await loadOrder(id, customer.id, false);

    if (!loaded) {
        notFound();
    }

    const { order } = loaded;

    return (
        <>
            <PageHeader
                title={`Bestellung ${order.number}`}
                intro={
                    order.status === "pending"
                        ? "Wir prüfen die Bestellung und richten die Leistungen anschließend ein."
                        : undefined
                }
            />

            <div className="space-y-12 px-6 py-10 md:px-10 md:py-12">
                <div className="flex flex-wrap items-center gap-4">
                    <StatusBadge
                        label={ORDER_STATUS_LABEL[order.status]}
                        tone={ORDER_STATUS_TONE[order.status]}
                    />
                    <span className="font-mono text-sm">
                        {formatPrice(order.grossCents)}
                    </span>
                    {loaded.invoice ? (
                        <Link
                            href="/client/invoices"
                            className="text-sm underline underline-offset-4"
                        >
                            Rechnung {loaded.invoice.number}
                        </Link>
                    ) : (
                        <span className="text-sm text-muted-foreground">
                            Heute ist nichts fällig — die erste Rechnung folgt
                            nach der Testphase.
                        </span>
                    )}
                </div>

                <OrderDetail loaded={loaded} />
            </div>
        </>
    );
}
