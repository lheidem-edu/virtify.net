import PageHeader from "@/components/shared/page-header";
import { db } from "@/db";
import { formatDate, formatPrice } from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { creditBalanceCents, listCreditLedger } from "@/server/payments/apply";
import { enabledGateways } from "@/server/payments/gateways";
import TopUpForm from "./top-up-form";

export const dynamic = "force-dynamic";

/**
 * The balance, and the entries that explain it.
 *
 * There is no balance column anywhere: the figure is the ledger added up, so
 * it cannot drift from the rows beneath it. A reader who disagrees with the
 * number can see exactly which entry they disagree with.
 */
export default async function Page() {
    const { customer } = await getCurrentCustomer();

    const [balance, entries, gateways] = await Promise.all([
        creditBalanceCents(db, customer.id),
        listCreditLedger(db, customer.id),
        enabledGateways(),
    ]);

    return (
        <>
            <PageHeader
                title="Guthaben"
                intro="Guthaben entsteht, wenn du mehr überweist als eine Rechnung verlangt, oder wenn du es aufladest. Es wird auf deine nächsten Rechnungen angerechnet."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <p className="text-muted-foreground text-xs">Aktuell</p>
                <p className="mt-1 font-mono text-3xl">
                    {formatPrice(balance)}
                </p>
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Guthaben aufladen
                </h2>
                <TopUpForm
                    gateways={gateways
                        .filter((one) => one.capabilities.hostedCheckout)
                        .map((one) => ({ id: one.id, label: one.label }))}
                />
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Bewegungen
                </h2>

                {entries.length === 0 ? (
                    <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                        Es gab noch keine Buchung.
                    </p>
                ) : (
                    <ul className="max-w-2xl divide-y rounded-lg border text-sm">
                        {entries.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                            >
                                <span>
                                    {entry.reason}
                                    <span className="block text-muted-foreground text-xs">
                                        {formatDate(entry.createdAt)}
                                    </span>
                                </span>
                                <span
                                    className={`font-mono ${entry.amountCents < 0 ? "text-muted-foreground" : ""}`}
                                >
                                    {entry.amountCents > 0 ? "+" : ""}
                                    {formatPrice(entry.amountCents)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
