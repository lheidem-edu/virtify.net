import Link from "next/link";
import { notFound } from "next/navigation";
import OrderDetail from "@/components/shared/order-detail";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import {
    formatDate,
    formatPrice,
    ORDER_STATUS_LABEL,
    ORDER_STATUS_TONE,
    PAYMENT_OPTION_LABEL,
} from "@/lib/format";
import {
    currentStaffCan,
    requirePermission,
} from "@/server/auth/staff-session";
import { ANY_CUSTOMER, loadOrder } from "@/server/orders/repository";
import OrderActions from "./order-actions";

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requirePermission("orders.read");

    const { id } = await params;
    const loaded = await loadOrder(id, ANY_CUSTOMER, true);

    if (!loaded) {
        notFound();
    }

    const { order } = loaded;
    const canDecide = await currentStaffCan("orders.write");

    return (
        <>
            <PageHeader
                title={`Bestellung ${order.number}`}
                intro={`${loaded.customer?.name ?? "Unbekannt"} · ${formatDate(order.placedAt)} · ${PAYMENT_OPTION_LABEL[order.paymentOption]}`}
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
                    {loaded.customer ? (
                        <Link
                            href={`/admin/customers/${loaded.customer.id}`}
                            className="text-sm underline underline-offset-4"
                        >
                            {loaded.customer.name}
                        </Link>
                    ) : null}
                    {loaded.invoice ? (
                        <Link
                            href={`/admin/invoices/${loaded.invoice.id}`}
                            className="text-sm underline underline-offset-4"
                        >
                            Rechnung {loaded.invoice.number}
                        </Link>
                    ) : (
                        <span className="text-sm text-muted-foreground">
                            Keine erste Rechnung — heute war nichts fällig.
                        </span>
                    )}
                    {order.autoCharge ? (
                        <StatusBadge label="Einzug gewünscht" />
                    ) : null}
                </div>

                {order.decisionReason ? (
                    <p className="text-sm text-muted-foreground">
                        Begründung: {order.decisionReason}
                    </p>
                ) : null}

                {order.status === "pending" && canDecide ? (
                    <section className="space-y-6 rounded-lg border p-6">
                        <h2 className="text-sm font-medium tracking-tight">
                            Entscheidung
                        </h2>
                        <OrderActions orderId={order.id} />
                    </section>
                ) : null}

                <OrderDetail loaded={loaded} />

                {order.ip || order.userAgent ? (
                    <section className="space-y-2 rounded-lg border p-6 text-xs text-muted-foreground">
                        <h2 className="text-sm font-medium tracking-tight text-foreground">
                            Herkunft
                        </h2>
                        <p>IP: {order.ip ?? "—"}</p>
                        <p className="break-all">
                            User-Agent: {order.userAgent ?? "—"}
                        </p>
                    </section>
                ) : null}
            </div>
        </>
    );
}
