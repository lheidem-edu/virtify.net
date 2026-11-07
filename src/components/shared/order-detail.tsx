import StatusBadge from "@/components/shared/status-badge";
import {
    formatDate,
    formatPrice,
    SERVICE_STATUS_LABEL,
    SERVICE_STATUS_TONE,
    SUBSCRIPTION_STATUS_LABEL,
    SUBSCRIPTION_STATUS_TONE,
} from "@/lib/format";
import { CYCLE_LABEL } from "@/server/billing/pricing";
import type { LoadedOrder } from "@/server/orders/repository";

/**
 * What an order turned into, rendered the same way for the customer and for
 * the operator. Presentational only — it receives rows and prints them, and
 * the two pages above it differ in what they are allowed to load, not in
 * what an order looks like.
 */
export default function OrderDetail({ loaded }: { loaded: LoadedOrder }) {
    const { order } = loaded;

    return (
        <div className="space-y-12">
            <section className="space-y-6">
                <h2 className="text-sm font-medium tracking-tight">
                    Positionen
                </h2>

                <ul className="space-y-4">
                    {loaded.items.map((item) => (
                        <li
                            key={item.id}
                            className="flex flex-wrap items-baseline justify-between gap-4 rounded-lg border p-6"
                        >
                            <div>
                                <p className="text-sm">
                                    {item.quantity > 1
                                        ? `${item.quantity} × `
                                        : ""}
                                    {item.description}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {CYCLE_LABEL[item.cycle]}
                                    {item.trialDays > 0
                                        ? ` · ${item.trialDays} Tage kostenlos`
                                        : ""}
                                    {item.couponCode
                                        ? ` · Gutschein ${item.couponCode}`
                                        : ""}
                                </p>
                            </div>
                            <dl className="flex gap-8 text-right text-sm">
                                <div>
                                    <dt className="text-xs text-muted-foreground">
                                        Heute
                                    </dt>
                                    <dd className="font-mono">
                                        {formatPrice(item.dueTodayCents)}
                                    </dd>
                                </div>
                                {item.cycle === "onetime" ? null : (
                                    <div>
                                        <dt className="text-xs text-muted-foreground">
                                            Je Zeitraum
                                        </dt>
                                        <dd className="font-mono">
                                            {formatPrice(item.renewalCents)}
                                        </dd>
                                    </div>
                                )}
                            </dl>
                        </li>
                    ))}
                </ul>
            </section>

            {loaded.subscriptions.length > 0 ? (
                <section className="space-y-6">
                    <h2 className="text-sm font-medium tracking-tight">
                        Abonnements
                    </h2>

                    <ul className="space-y-4">
                        {loaded.subscriptions.map(({ subscription, items }) => (
                            <li
                                key={subscription.id}
                                className="space-y-4 rounded-lg border p-6"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-4">
                                    <p className="text-sm">
                                        {CYCLE_LABEL[subscription.cycle]}
                                        {subscription.trialEndsAt ? (
                                            <span className="text-muted-foreground">
                                                {" "}
                                                · Testphase bis{" "}
                                                {formatDate(
                                                    subscription.trialEndsAt,
                                                )}
                                            </span>
                                        ) : null}
                                    </p>
                                    <StatusBadge
                                        label={
                                            SUBSCRIPTION_STATUS_LABEL[
                                                subscription.status
                                            ]
                                        }
                                        tone={
                                            SUBSCRIPTION_STATUS_TONE[
                                                subscription.status
                                            ]
                                        }
                                    />
                                </div>

                                <ul className="space-y-1 text-xs text-muted-foreground">
                                    {items.map((item) => (
                                        <li key={item.id}>
                                            {item.quantity > 1
                                                ? `${item.quantity} × `
                                                : ""}
                                            {item.description} —{" "}
                                            {formatPrice(
                                                item.recurringGrossCents,
                                            )}{" "}
                                            je Zeitraum
                                        </li>
                                    ))}
                                </ul>

                                <p className="text-xs text-muted-foreground">
                                    Laufender Zeitraum ab{" "}
                                    {formatDate(
                                        subscription.currentPeriodStart,
                                    )}
                                    {subscription.nextBillingAt
                                        ? ` · nächste Abrechnung ${formatDate(subscription.nextBillingAt)}`
                                        : " · keine Verlängerung"}
                                </p>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {loaded.services.length > 0 ? (
                <section className="space-y-6">
                    <h2 className="text-sm font-medium tracking-tight">
                        Leistungen
                    </h2>

                    <ul className="space-y-3">
                        {loaded.services.map((service) => (
                            <li
                                key={service.id}
                                className="flex items-center justify-between gap-4 rounded-lg border px-6 py-4 text-sm"
                            >
                                <span>{service.label}</span>
                                <StatusBadge
                                    label={SERVICE_STATUS_LABEL[service.status]}
                                    tone={SERVICE_STATUS_TONE[service.status]}
                                />
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            <section className="space-y-4 rounded-lg border p-6 text-xs text-muted-foreground">
                <h2 className="text-sm font-medium tracking-tight text-foreground">
                    Bestätigungen
                </h2>
                <p>
                    AGB bestätigt am {formatDate(order.termsAcceptedAt)}
                    {order.termsLabel ? ` — ${order.termsLabel}` : ""}.
                </p>
                {order.isConsumer ? (
                    <>
                        <p>
                            Widerrufsbelehrung zur Kenntnis genommen am{" "}
                            {formatDate(order.withdrawalAcceptedAt)}.
                        </p>
                        <p>
                            Ausdrückliches Verlangen nach sofortigem
                            Leistungsbeginn am{" "}
                            {formatDate(order.immediateStartRequestedAt)}.
                        </p>
                    </>
                ) : (
                    <p>
                        Unternehmer — kein Widerrufsrecht (§ 312g i. V. m. § 13
                        BGB).
                    </p>
                )}
            </section>
        </div>
    );
}
