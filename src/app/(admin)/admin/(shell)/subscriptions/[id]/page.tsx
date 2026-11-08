import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { berlinDay } from "@/lib/berlin-date";
import {
    formatDate,
    formatPrice,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
    SERVICE_STATUS_LABEL,
    SERVICE_STATUS_TONE,
    SUBSCRIPTION_STATUS_LABEL,
    SUBSCRIPTION_STATUS_TONE,
} from "@/lib/format";
import {
    currentStaffCan,
    requirePermission,
} from "@/server/auth/staff-session";
import { CYCLE_LABEL } from "@/server/billing/pricing";
import {
    ANY_CUSTOMER,
    loadSubscription,
} from "@/server/subscriptions/repository";
import RunBillingButton from "../run-billing-button";
import {
    AdjustForm,
    ChangeForm,
    LifecycleActions,
    RevokeRenewalButton,
    WithdrawChangeButton,
} from "./subscription-actions";

const INVOICE_KIND_LABEL: Record<string, string> = {
    initial: "Bestellung",
    renewal: "Verlängerung",
    change: "Tarifwechsel",
    dunning_fee: "Mahngebühr",
};

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requirePermission("subscriptions.read");

    const { id } = await params;
    const loaded = await loadSubscription(id, ANY_CUSTOMER, true);

    if (!loaded) {
        notFound();
    }

    const { subscription, items, customer, invoices, events, pendingChanges } =
        loaded;
    const mayWrite = await currentStaffCan("subscriptions.write");
    const mayBill = await currentStaffCan("billing.write");
    const mayRun = await currentStaffCan("jobs.manage");

    const periodGrossCents = items.reduce(
        (total, item) => total + item.recurringGrossCents,
        0,
    );

    const facts: { label: string; value: string }[] = [
        { label: "Rhythmus", value: CYCLE_LABEL[subscription.cycle] },
        {
            label: "Je Zeitraum",
            value: formatPrice(periodGrossCents),
        },
        {
            label: "Laufender Zeitraum",
            value: subscription.currentPeriodEnd
                ? `${formatDate(subscription.currentPeriodStart)} – ${formatDate(
                      new Date(subscription.currentPeriodEnd.getTime() - 1),
                  )}`
                : formatDate(subscription.currentPeriodStart),
        },
        {
            label: "Nächste Abrechnung",
            value: subscription.nextBillingAt
                ? formatDate(subscription.nextBillingAt)
                : "—",
        },
        {
            label: "Testphase bis",
            value: subscription.trialEndsAt
                ? formatDate(subscription.trialEndsAt)
                : "—",
        },
        {
            label: "Automatischer Einzug",
            value: subscription.autoCharge ? "ja" : "nein",
        },
        {
            label: "Zahlungsmittel",
            value: loaded.paymentMethod?.label ?? "Standard des Kontos",
        },
        {
            label: "Gutschein",
            value: subscription.couponCode
                ? `${subscription.couponCode} · noch ${
                      subscription.discountPeriodsRemaining === null
                          ? "dauerhaft"
                          : `${subscription.discountPeriodsRemaining} Zeiträume`
                  }`
                : "—",
        },
    ];

    return (
        <>
            <PageHeader
                title={items[0]?.description ?? "Abo"}
                intro={
                    customer
                        ? `${customer.name} (${customer.customerNumber})`
                        : undefined
                }
                action={mayRun ? <RunBillingButton /> : undefined}
            />

            <div className="space-y-10 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <StatusBadge
                            label={
                                SUBSCRIPTION_STATUS_LABEL[subscription.status]
                            }
                            tone={SUBSCRIPTION_STATUS_TONE[subscription.status]}
                        />
                        {subscription.cancelAtPeriodEnd ? (
                            <StatusBadge
                                label="endet zum Ende des Zeitraums"
                                tone="warning"
                            />
                        ) : null}
                        {customer ? (
                            <Link
                                href={`/admin/customers/${customer.id}`}
                                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                            >
                                Kundenkonto öffnen
                            </Link>
                        ) : null}
                    </div>

                    <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        {facts.map((fact) => (
                            <div key={fact.label}>
                                <dt className="text-xs text-muted-foreground">
                                    {fact.label}
                                </dt>
                                <dd>{fact.value}</dd>
                            </div>
                        ))}
                    </dl>

                    {mayWrite ? (
                        <LifecycleActions
                            subscriptionId={subscription.id}
                            status={subscription.status}
                            cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
                        />
                    ) : null}
                </section>

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Positionen</h2>
                    <ul className="space-y-3">
                        {items.map((item) => (
                            <li
                                key={item.id}
                                className="rounded-lg border px-6 py-4"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-4">
                                    <span>
                                        <span className="text-sm">
                                            {item.description}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                            {item.quantity} ×{" "}
                                            {formatPrice(item.unitPriceCents)}{" "}
                                            je Zeitraum
                                        </span>
                                    </span>
                                    <span className="font-mono text-sm">
                                        {formatPrice(item.recurringGrossCents)}
                                    </span>
                                </div>

                                {item.services.length > 0 ? (
                                    <ul className="mt-3 space-y-1 border-t pt-3 text-xs">
                                        {item.services.map((service) => (
                                            <li
                                                key={service.id}
                                                className="flex items-center justify-between gap-4"
                                            >
                                                <span className="text-muted-foreground">
                                                    {service.label}
                                                </span>
                                                <StatusBadge
                                                    label={
                                                        SERVICE_STATUS_LABEL[
                                                            service.status
                                                        ]
                                                    }
                                                    tone={
                                                        SERVICE_STATUS_TONE[
                                                            service.status
                                                        ]
                                                    }
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>

                {pendingChanges.length > 0 ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">
                            Vorgemerkte Tarifwechsel
                        </h2>
                        <ul className="space-y-3">
                            {pendingChanges.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4 text-sm"
                                >
                                    <span>
                                        {entry.description} ({entry.quantity} ×)
                                        <span className="block text-xs text-muted-foreground">
                                            ab {formatDate(entry.applyAt)} ·{" "}
                                            {formatPrice(
                                                entry.recurringGrossCents,
                                            )}{" "}
                                            je Zeitraum
                                        </span>
                                    </span>
                                    {mayWrite ? (
                                        <WithdrawChangeButton
                                            subscriptionId={subscription.id}
                                            changeId={entry.id}
                                            description={entry.description}
                                        />
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}

                {mayWrite ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Tarif wechseln</h2>
                        <p className="max-w-2xl text-sm text-muted-foreground">
                            Die Vorschau rechnet denselben Betrag aus, der
                            anschließend gebucht wird — ein Upgrade wird für die
                            Resttage in Rechnung gestellt, ein Downgrade dem
                            Guthaben gutgeschrieben.
                        </p>
                        <ChangeForm
                            subscriptionId={subscription.id}
                            items={items.map((item) => ({
                                id: item.id,
                                description: item.description,
                                quantity: item.quantity,
                                unitPriceCents: item.unitPriceCents,
                            }))}
                        />
                    </section>
                ) : null}

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Rechnungen</h2>
                    {invoices.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Noch keine.
                        </p>
                    ) : (
                        <ul className="space-y-3">
                            {invoices.map((invoice) => (
                                <li
                                    key={`${invoice.id}-${invoice.periodStart.toISOString()}`}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4"
                                >
                                    <span>
                                        <Link
                                            href={`/admin/invoices/${invoice.id}`}
                                            className="font-mono text-sm underline-offset-4 hover:underline"
                                        >
                                            {invoice.number ?? "Entwurf"}
                                        </Link>
                                        <span className="block text-xs text-muted-foreground">
                                            {INVOICE_KIND_LABEL[invoice.kind] ??
                                                invoice.kind}{" "}
                                            ·{" "}
                                            {invoice.periodEnd
                                                ? `${formatDate(invoice.periodStart)} – ${formatDate(
                                                      new Date(
                                                          invoice.periodEnd.getTime() -
                                                              1,
                                                      ),
                                                  )}`
                                                : formatDate(
                                                      invoice.periodStart,
                                                  )}
                                            {invoice.dueAt
                                                ? ` · fällig ${formatDate(invoice.dueAt)}`
                                                : ""}
                                        </span>
                                    </span>
                                    <span className="flex items-center gap-4">
                                        <span className="font-mono text-sm">
                                            {formatPrice(
                                                invoice.grossCents ?? 0,
                                            )}
                                        </span>
                                        <StatusBadge
                                            label={
                                                INVOICE_STATUS_LABEL[
                                                    invoice.status as keyof typeof INVOICE_STATUS_LABEL
                                                ] ?? invoice.status
                                            }
                                            tone={
                                                INVOICE_STATUS_TONE[
                                                    invoice.status as keyof typeof INVOICE_STATUS_TONE
                                                ] ?? "neutral"
                                            }
                                        />
                                        {mayBill &&
                                        invoice.kind === "renewal" &&
                                        invoice.status !== "cancelled" ? (
                                            <RevokeRenewalButton
                                                subscriptionId={subscription.id}
                                                invoiceId={invoice.id}
                                                number={invoice.number}
                                            />
                                        ) : null}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {mayWrite ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Anpassen</h2>
                        <AdjustForm
                            subscriptionId={subscription.id}
                            nextBillingAt={
                                subscription.nextBillingAt
                                    ? berlinDay(subscription.nextBillingAt)
                                    : null
                            }
                            autoCharge={subscription.autoCharge}
                            items={items.map((item) => ({
                                id: item.id,
                                description: item.description,
                                quantity: item.quantity,
                                unitPriceCents: item.unitPriceCents,
                            }))}
                        />
                    </section>
                ) : null}

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Verlauf</h2>
                    {events.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Noch nichts passiert.
                        </p>
                    ) : (
                        <ol className="space-y-2 text-sm">
                            {events.map((event) => (
                                <li
                                    key={event.id}
                                    className="flex flex-wrap gap-x-4 border-b pb-2"
                                >
                                    <span className="w-40 shrink-0 text-xs text-muted-foreground">
                                        {formatDate(event.at)}
                                    </span>
                                    <span>{event.summary}</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </section>
            </div>
        </>
    );
}
