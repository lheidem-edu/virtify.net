import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { formatPrice } from "@/lib/format";
import { getSession } from "@/server/auth/session";
import { CYCLE_LABEL } from "@/server/billing/pricing";
import { loadCartItems } from "@/server/cart/repository";
import { currentCart } from "@/server/cart/session";
import { priceCart } from "@/server/cart/view";
import { customerForUser } from "@/server/customers/repository";
import { currentLegalVersion } from "@/server/legal/repository";
import { enabledGateways } from "@/server/payments/gateways";
import { loadSettings } from "@/server/settings";
import CheckoutForm from "./checkout-form";
import CheckoutIdentity from "./identity";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Kasse",
    description: "Bestellung abschließen.",
};

/**
 * The checkout.
 *
 * Two steps, in one page: say who you are, then confirm what is ordered.
 * Nothing here holds a price — the summary is rendered from the same
 * `priceCart` the cart page uses, and the submit re-prices everything a
 * third time inside the transaction that writes the order. Three readings of
 * one function, never two implementations.
 */
export default async function Page() {
    const cart = await currentCart();
    const items = cart ? await loadCartItems(db, cart.id) : [];

    if (!cart || items.length === 0) {
        redirect("/cart");
    }

    // The billing anchor belongs in the quote: with one set, the first
    // period is short and is priced for the days it covers. Leaving it out
    // here would print a figure the invoice then contradicts.
    const settings = await loadSettings();
    const priced = await priceCart(db, cart, items, {
        anchorDay: settings.policy.billingAnchorDay,
    });

    if (!priced.orderable) {
        // Something in the basket cannot be priced any more. The cart page
        // says which; ordering it would charge for something else.
        redirect("/cart");
    }

    const session = await getSession();
    const account = session ? await customerForUser(db, session.user.id) : null;
    const terms = await currentLegalVersion(db, "terms");

    /**
     * Which ways of paying are offered, and in which order. Bank transfer is
     * last: it is the one that leaves an invoice open, and § 312j BGB wants
     * the buyer to be able to pay without a detour, not to be steered into
     * the slowest option.
     */
    const PAYMENT_HINTS: Record<string, string> = {
        stripe: "Sie werden zur gesicherten Zahlungsseite weitergeleitet und zahlen direkt.",
        paypal: "Sie werden zu PayPal weitergeleitet und zahlen direkt.",
        banktransfer:
            "Sie erhalten eine Rechnung mit Bankverbindung und GiroCode und überweisen innerhalb der Zahlungsfrist.",
    };

    const paymentOptions = (await enabledGateways()).map((one) => ({
        id: one.id,
        label: one.label,
        hint: PAYMENT_HINTS[one.id] ?? "",
    }));

    return (
        <>
            <section className="border-b px-6 py-20 md:px-10 md:py-24">
                <h1 className="max-w-4xl text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl">
                    Kasse
                </h1>
                <p className="mt-8 max-w-2xl text-lg text-zinc-300">
                    {account
                        ? "Rechnungsanschrift prüfen, bestätigen, bestellen."
                        : "Melden Sie sich an oder legen Sie ein Konto an — der Warenkorb bleibt liegen."}
                </p>
            </section>

            <section className="px-6 py-16 md:px-10">
                {/*
                 * § 312j Abs. 2 BGB wants the Gesamtpreis and the wesentliche
                 * Merkmale "unmittelbar bevor der Verbraucher seine Bestellung
                 * abgibt". The two columns only exist from `lg` up; below it
                 * the grid collapses in source order, so with the form first
                 * a phone showed the total *under* the ordering button. The
                 * summary therefore comes first in the DOM and is moved back
                 * to the right-hand column by `order` once there are columns
                 * to move it between.
                 */}
                <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem]">
                    <aside className="h-fit space-y-6 rounded-lg border p-6 lg:order-2 lg:sticky lg:top-24">
                        <h2 className="text-sm font-medium tracking-tight">
                            Bestellung
                        </h2>

                        <ul className="space-y-4 text-sm">
                            {priced.entries.map((entry) => (
                                <li
                                    key={entry.item.id}
                                    className="flex items-baseline justify-between gap-4"
                                >
                                    <span>
                                        {entry.item.quantity > 1
                                            ? `${entry.item.quantity} × `
                                            : ""}
                                        {entry.quote?.productName}
                                        <span className="block text-xs text-zinc-500">
                                            {CYCLE_LABEL[entry.item.cycle]}
                                        </span>
                                    </span>
                                    <span className="shrink-0 tabular-nums">
                                        {formatPrice(
                                            entry.quote?.totals.dueTodayCents ??
                                                0,
                                        )}
                                    </span>
                                </li>
                            ))}
                        </ul>

                        <dl className="space-y-3 border-t pt-6 text-sm">
                            <div className="flex items-baseline justify-between gap-4">
                                <dt className="font-medium">Heute fällig</dt>
                                <dd className="tabular-nums">
                                    {formatPrice(priced.dueTodayCents)}
                                </dd>
                            </div>
                            {priced.recurring.map((group) => (
                                <div
                                    key={group.cycle}
                                    className="flex items-baseline justify-between gap-4 text-zinc-500"
                                >
                                    <dt>Danach {CYCLE_LABEL[group.cycle]}</dt>
                                    <dd className="tabular-nums">
                                        {formatPrice(group.renewalCents)}
                                    </dd>
                                </div>
                            ))}
                        </dl>

                        <p className="border-t pt-6 text-xs leading-5 text-zinc-500">
                            Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.{" "}
                            <Link
                                href="/cart"
                                className="underline underline-offset-4"
                            >
                                Warenkorb ändern
                            </Link>
                        </p>
                    </aside>

                    <div className="lg:order-1">
                        {account ? (
                            <CheckoutForm
                                customer={{
                                    kind: account.customer.kind,
                                    name: account.customer.name,
                                    company: account.customer.company,
                                    street: account.customer.street,
                                    postalCode: account.customer.postalCode,
                                    city: account.customer.city,
                                    country: account.customer.country,
                                    vatId: account.customer.vatId,
                                    phone: account.customer.phone,
                                }}
                                termsLabel={terms.label}
                                gateways={paymentOptions}
                            />
                        ) : (
                            <CheckoutIdentity />
                        )}
                    </div>
                </div>
            </section>
        </>
    );
}
