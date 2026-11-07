import Link from "next/link";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { formatPrice } from "@/lib/format";
import { CYCLE_LABEL } from "@/server/billing/pricing";
import { loadCartItems } from "@/server/cart/repository";
import { currentCart } from "@/server/cart/session";
import { priceCart } from "@/server/cart/view";
import CartLines from "./cart-lines";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Warenkorb",
    description:
        "Was im Warenkorb liegt, mit den Preisen, die berechnet werden.",
};

/**
 * The cart.
 *
 * Everything on this page is computed server-side by the one price function,
 * on every render. The cart row holds a configuration — which product, which
 * cycle, which add-ons, how many — and no amounts at all, so there is no
 * stored total that could go stale when a price changes underneath it, and
 * no figure the browser could have written.
 */
export default async function Page() {
    const cart = await currentCart();
    const items = cart ? await loadCartItems(db, cart.id) : [];
    const priced = cart ? await priceCart(db, cart, items) : null;

    return (
        <>
            <section className="border-b px-6 py-20 md:px-10 md:py-24">
                <h1 className="max-w-4xl text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl">
                    Warenkorb
                </h1>
                <p className="mt-8 max-w-2xl text-lg text-zinc-300">
                    Jeder Betrag hier wird beim Aufruf neu aus dem Katalog
                    gerechnet — von derselben Funktion, die ihn auf die Rechnung
                    schreibt.
                </p>
            </section>

            <section className="px-6 py-16 md:px-10">
                {!priced || priced.entries.length === 0 ? (
                    <div className="space-y-6">
                        <p className="text-zinc-400">
                            Es liegt nichts im Warenkorb.
                        </p>
                        <Button
                            nativeButton={false}
                            render={<Link href="/products" />}
                            variant="outline"
                        >
                            Produkte ansehen
                        </Button>
                    </div>
                ) : (
                    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem]">
                        <CartLines
                            entries={priced.entries.map((entry) => ({
                                id: entry.item.id,
                                name:
                                    entry.quote?.productName ??
                                    entry.detail?.product.name ??
                                    "Unbekanntes Produkt",
                                cycleLabel: CYCLE_LABEL[entry.item.cycle],
                                quantity: entry.item.quantity,
                                couponCode: entry.item.couponCode,
                                couponError: entry.quote?.couponError ?? null,
                                couponLabel: entry.quote?.coupon
                                    ? `${entry.quote.coupon.code} (${entry.quote.coupon.label})`
                                    : null,
                                problem: entry.problem,
                                lines:
                                    entry.quote?.lines.map((line) => ({
                                        // Unique within one quote: at most
                                        // one base line, one line per option
                                        // value, and one discount per side.
                                        key: [
                                            line.kind,
                                            line.optionId ?? "",
                                            line.valueId ?? "",
                                            line.recurring,
                                        ].join(":"),
                                        label: line.label,
                                        detail: line.detail ?? null,
                                        quantity: line.quantity,
                                        amount: formatPrice(line.amountCents),
                                    })) ?? [],
                                dueToday: formatPrice(
                                    entry.quote?.totals.dueTodayCents ?? 0,
                                ),
                                trialDays: entry.quote?.totals.trialDays ?? 0,
                            }))}
                        />

                        <aside className="h-fit space-y-6 rounded-lg border p-6 lg:sticky lg:top-24">
                            <h2 className="text-sm font-medium tracking-tight">
                                Summe
                            </h2>

                            <dl className="space-y-3 text-sm">
                                <div className="flex items-baseline justify-between gap-4">
                                    <dt className="font-medium">
                                        Heute fällig
                                    </dt>
                                    <dd className="tabular-nums">
                                        {formatPrice(priced.dueTodayCents)}
                                    </dd>
                                </div>

                                {priced.recurring.map((group) => (
                                    <div
                                        key={group.cycle}
                                        className="flex items-baseline justify-between gap-4 text-zinc-500"
                                    >
                                        <dt>
                                            Danach {CYCLE_LABEL[group.cycle]}
                                        </dt>
                                        <dd className="tabular-nums">
                                            {formatPrice(group.renewalCents)}
                                        </dd>
                                    </div>
                                ))}
                            </dl>

                            {priced.problems.length > 0 ? (
                                <ul className="space-y-2 border-t pt-6 text-xs text-destructive">
                                    {priced.problems.map((problem) => (
                                        <li key={problem}>{problem}</li>
                                    ))}
                                </ul>
                            ) : null}

                            <div className="border-t pt-6">
                                <Button
                                    nativeButton={false}
                                    render={<Link href="/checkout" />}
                                    className="w-full"
                                    disabled={!priced.orderable}
                                >
                                    Zur Kasse
                                </Button>
                            </div>

                            <p className="text-xs leading-5 text-zinc-500">
                                Gemäß § 19 UStG wird keine Umsatzsteuer
                                berechnet.
                            </p>
                        </aside>
                    </div>
                )}
            </section>
        </>
    );
}
