import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
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
import { CYCLE_LABEL } from "@/server/billing/pricing";
import { getCurrentCustomer } from "@/server/customers/current";
import { loadSubscription } from "@/server/subscriptions/repository";
import { CancelForm, ChangeForm } from "./subscription-forms";

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
    const { customer } = await getCurrentCustomer();
    const { id } = await params;

    // Scoped in the query: an id that is not this account's comes back null
    // and the page is simply not there.
    const loaded = await loadSubscription(id, customer.id, false);

    if (!loaded) {
        notFound();
    }

    const { subscription, items, invoices, events, pendingChanges } = loaded;
    const periodGrossCents = items.reduce(
        (total, item) => total + item.recurringGrossCents,
        0,
    );

    return (
        <>
            <PageHeader
                title={items[0]?.description ?? "Abo"}
                intro={`${CYCLE_LABEL[subscription.cycle]} · ${formatPrice(periodGrossCents)} je Zeitraum`}
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
                    </div>

                    {subscription.status === "past_due" ? (
                        <p className="rounded-lg border border-amber-500/40 p-4 text-sm">
                            Eine Rechnung zu diesem Abo ist überfällig. Sobald
                            sie beglichen ist, läuft alles automatisch weiter —
                            gesperrte Leistungen werden dabei von selbst wieder
                            freigeschaltet.
                        </p>
                    ) : null}

                    <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                            <dt className="text-xs text-muted-foreground">
                                Laufender Zeitraum
                            </dt>
                            <dd>
                                {subscription.currentPeriodEnd
                                    ? `${formatDate(subscription.currentPeriodStart)} – ${formatDate(
                                          new Date(
                                              subscription.currentPeriodEnd.getTime() -
                                                  1,
                                          ),
                                      )}`
                                    : formatDate(
                                          subscription.currentPeriodStart,
                                      )}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-foreground">
                                Nächste Abrechnung
                            </dt>
                            <dd>
                                {subscription.cancelAtPeriodEnd
                                    ? "—"
                                    : subscription.nextBillingAt
                                      ? formatDate(subscription.nextBillingAt)
                                      : "—"}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-foreground">
                                Testphase bis
                            </dt>
                            <dd>
                                {subscription.trialEndsAt
                                    ? formatDate(subscription.trialEndsAt)
                                    : "—"}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-foreground">
                                Einzug
                            </dt>
                            <dd>
                                {subscription.autoCharge
                                    ? "automatisch"
                                    : "auf Rechnung"}
                            </dd>
                        </div>
                    </dl>

                    <CancelForm
                        subscriptionId={subscription.id}
                        cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
                        endsAt={
                            subscription.currentPeriodEnd
                                ? formatDate(
                                      new Date(
                                          subscription.currentPeriodEnd.getTime() -
                                              1,
                                      ),
                                  )
                                : null
                        }
                    />
                </section>

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Leistungen</h2>
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
                    <section className="space-y-3">
                        <h2 className="text-sm font-medium">
                            Vorgemerkte Änderungen
                        </h2>
                        <ul className="space-y-2 text-sm">
                            {pendingChanges.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="rounded-lg border px-6 py-4"
                                >
                                    Wechsel auf {entry.description} ab{" "}
                                    {formatDate(entry.applyAt)} —{" "}
                                    {formatPrice(entry.recurringGrossCents)} je
                                    Zeitraum.
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}

                {subscription.status !== "ended" ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Tarif wechseln</h2>
                        <p className="max-w-2xl text-sm text-muted-foreground">
                            „Preis anzeigen“ rechnet aus, was der Wechsel
                            kostet. Bei einem sofortigen Wechsel wird die
                            Differenz für die Resttage berechnet — oder dir
                            gutgeschrieben, wenn du günstiger wirst.
                        </p>
                        <ChangeForm
                            subscriptionId={subscription.id}
                            items={items.map((item) => ({
                                id: item.id,
                                description: item.description,
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
                                            href={`/client/invoices/${invoice.id}`}
                                            className="font-mono text-sm underline-offset-4 hover:underline"
                                        >
                                            {invoice.number ?? "Entwurf"}
                                        </Link>
                                        <span className="block text-xs text-muted-foreground">
                                            {INVOICE_KIND_LABEL[invoice.kind] ??
                                                invoice.kind}
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
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {events.length > 0 ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Verlauf</h2>
                        <ol className="space-y-2 text-sm">
                            {events.slice(0, 20).map((event) => (
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
                    </section>
                ) : null}
            </div>
        </>
    );
}
