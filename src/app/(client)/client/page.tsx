import {
    AlertTriangle,
    LifeBuoy,
    Receipt,
    Repeat,
    Server,
    Wallet,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import PageHeader from "@/components/shared/page-header";
import { db } from "@/db";
import { toLocale } from "@/i18n/locale";
import { formatDateIn, formatPriceIn } from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { loadDashboard } from "@/server/customers/dashboard";

/**
 * What the customer sees first.
 *
 * Five figures and a list of things to do something about. Everything on it
 * is scoped by `getCurrentCustomer()` — no id comes from the request — and
 * every figure is read through `loadDashboard`, which asks
 * `OPEN_INVOICE_STATUSES` rather than a status literal, so this page cannot
 * disagree with the dunning ladder about what "offen" means.
 *
 * The attention list is deliberately above the figures: a suspended server or
 * an overdue invoice is the only thing on this page a customer can act on,
 * and a dashboard that leads with four green numbers buries it.
 */

const CARD =
    "flex flex-col gap-2 rounded-lg border p-6 transition-colors hover:border-ring";

export default async function Page() {
    const { customer, user } = await getCurrentCustomer();
    const locale = toLocale(await getLocale());
    const t = await getTranslations("portal.dashboard");

    const data = await loadDashboard(db, customer.id, {
        currency: customer.currency,
    });

    const price = (cents: number) =>
        formatPriceIn(locale, cents, data.currency);

    const addressMissing =
        !customer.street || !customer.postalCode || !customer.city;

    const cards = [
        {
            href: "/client/subscriptions",
            icon: Repeat,
            label: t("subscriptions"),
            value: t("subscriptionsActive", {
                count: data.subscriptions.active,
            }),
            hint: t("subscriptionsHint", { count: data.subscriptions.total }),
        },
        {
            href: "/client/services",
            icon: Server,
            label: t("services"),
            value: t("servicesActive", { count: data.services.active }),
            hint: t("servicesHint", { count: data.services.total }),
        },
        {
            href: "/client/invoices",
            icon: Receipt,
            label: t("invoices"),
            value: t("invoicesOpen", { count: data.invoices.open }),
            hint:
                data.invoices.open > 0
                    ? t("invoicesHint", {
                          amount: price(data.invoices.outstandingCents),
                      })
                    : t("invoicesNone"),
        },
        {
            href: "/client/tickets",
            icon: LifeBuoy,
            label: t("tickets"),
            value: t("ticketsOpen", { count: data.tickets.open }),
            hint: t("ticketsHint"),
        },
        {
            href: "/client/credit",
            icon: Wallet,
            label: t("credit"),
            value:
                data.creditCents > 0
                    ? price(data.creditCents)
                    : t("creditNone"),
            hint: data.creditCents > 0 ? t("creditHint") : t("nothingDue"),
        },
    ];

    return (
        <>
            <PageHeader
                title={t("title")}
                intro={
                    user.name
                        ? t("welcomeNamed", { name: user.name })
                        : t("welcome")
                }
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {addressMissing ? (
                    <p className="mb-8 max-w-3xl rounded-lg border p-4 text-sm leading-6 text-muted-foreground">
                        {t("addressMissing")}{" "}
                        <Link
                            href="/client/profile"
                            className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-current"
                        >
                            {t("addressAction")}
                        </Link>
                    </p>
                ) : null}

                {data.attention.length > 0 ? (
                    <section className="mb-10 max-w-3xl space-y-3">
                        <h2 className="flex items-center gap-2 text-sm font-medium">
                            <AlertTriangle className="size-4 text-amber-500" />
                            {t("attention")}
                        </h2>
                        <ul className="space-y-2">
                            {data.attention.map((item) => (
                                <li
                                    key={
                                        item.kind === "overdue"
                                            ? `invoice:${item.invoiceId}`
                                            : item.kind === "suspended"
                                              ? `service:${item.serviceId}`
                                              : `trial:${item.subscriptionId}`
                                    }
                                    className="rounded-lg border border-amber-500/40 px-6 py-4 text-sm leading-6"
                                >
                                    {item.kind === "overdue" ? (
                                        <Link
                                            href={`/client/invoices/${item.invoiceId}`}
                                            className="underline decoration-border underline-offset-4 transition-colors hover:decoration-current"
                                        >
                                            {t("overdue", {
                                                number: item.number,
                                                amount: price(item.amountCents),
                                                day: formatDateIn(
                                                    locale,
                                                    item.dueAt,
                                                ),
                                            })}
                                        </Link>
                                    ) : item.kind === "suspended" ? (
                                        <Link
                                            href={`/client/services/${item.serviceId}`}
                                            className="underline decoration-border underline-offset-4 transition-colors hover:decoration-current"
                                        >
                                            {t("suspended", {
                                                label: item.label,
                                            })}
                                        </Link>
                                    ) : (
                                        <Link
                                            href={`/client/subscriptions/${item.subscriptionId}`}
                                            className="underline decoration-border underline-offset-4 transition-colors hover:decoration-current"
                                        >
                                            {t("trialEnds", {
                                                label: item.label,
                                                day: formatDateIn(
                                                    locale,
                                                    item.endsAt,
                                                ),
                                            })}
                                        </Link>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}

                <div className="grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {cards.map((card) => (
                        <Link key={card.href} href={card.href} className={CARD}>
                            <card.icon className="size-4 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">
                                {card.label}
                            </span>
                            <span className="text-lg font-medium tracking-tight">
                                {card.value}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {card.hint}
                            </span>
                        </Link>
                    ))}
                </div>

                <p className="mt-8 max-w-3xl text-sm text-muted-foreground">
                    {t("nextRenewal")}:{" "}
                    {data.nextRenewal ? (
                        <Link
                            href={`/client/subscriptions/${data.nextRenewal.subscriptionId}`}
                            className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-current"
                        >
                            {t("nextRenewalOn", {
                                label: data.nextRenewal.label,
                                day: formatDateIn(locale, data.nextRenewal.at),
                            })}
                        </Link>
                    ) : (
                        t("nothingDue")
                    )}
                </p>
            </div>
        </>
    );
}
