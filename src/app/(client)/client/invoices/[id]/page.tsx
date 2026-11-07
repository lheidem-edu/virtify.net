import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { isOpenInvoice } from "@/db/schema";
import {
    formatDate,
    formatPrice,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
    PAYMENT_PROVIDER_LABEL,
    PAYMENT_STATUS_LABEL,
} from "@/lib/format";
import { subtract } from "@/lib/money";
import { loadInvoice } from "@/server/billing/invoices/repository";
import { getCurrentCustomer } from "@/server/customers/current";
import {
    creditBalanceCents,
    paymentsForInvoice,
} from "@/server/payments/apply";
import { enabledGateways } from "@/server/payments/gateways";
import { bankTransferGateway } from "@/server/payments/gateways/banktransfer";
import PayActions from "../pay-actions";

/**
 * One invoice, and every way of paying it.
 *
 * The figures here are the document's own: `calculateTotals()` froze the
 * gross at finalization, corrections are what `credited_cents` says, and what
 * has arrived is what `applyPayment` wrote. Nothing on this page adds up a
 * line.
 */
export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { customer } = await getCurrentCustomer();
    const { id } = await params;

    const loaded = await loadInvoice(id, customer.id, false);

    // Ownership lives in the query: somebody else's invoice is simply not
    // here, and a draft has no legal existence to show a customer.
    if (!loaded || loaded.invoice.status === "draft") {
        notFound();
    }

    const { invoice, items, totals } = loaded;
    const number = invoice.number ?? invoice.id;

    const due = Math.max(subtract(totals.grossCents, invoice.creditedCents), 0);
    const outstanding = subtract(due, invoice.paidCents);
    const payable = isOpenInvoice(invoice.status) && outstanding > 0;

    const gateways = payable ? await enabledGateways() : [];
    const balance = await creditBalanceCents(db, customer.id);
    const payments = (await paymentsForInvoice(db, invoice.id)).filter(
        (row) => row.status !== "pending",
    );

    // The bank details and the GiroCode, for the amount that is still open.
    const transfer =
        payable && gateways.some((one) => one.id === "banktransfer")
            ? await bankTransferGateway.createCheckout(
                  {
                      id: invoice.id,
                      number,
                      amountCents: outstanding,
                      currency: invoice.currency,
                      customerId: customer.id,
                      customerEmail: "",
                      customerName: customer.name,
                  },
                  { attempt: 1 },
              )
            : null;

    return (
        <>
            <PageHeader
                title={`Rechnung ${number}`}
                intro={`${formatDate(invoice.issuedAt)} · ${formatPrice(totals.grossCents)}`}
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <div className="flex max-w-2xl flex-wrap items-center gap-3">
                    <StatusBadge
                        label={INVOICE_STATUS_LABEL[invoice.status]}
                        tone={INVOICE_STATUS_TONE[invoice.status]}
                    />
                    {invoice.dueAt ? (
                        <span className="text-muted-foreground text-sm">
                            Fällig am {formatDate(invoice.dueAt)}
                        </span>
                    ) : null}
                </div>

                <dl className="mt-8 max-w-2xl divide-y rounded-lg border text-sm">
                    <Row label="Rechnungsbetrag" value={totals.grossCents} />
                    {invoice.creditedCents > 0 ? (
                        <Row
                            label="Durch Korrekturen zurückgenommen"
                            value={-invoice.creditedCents}
                        />
                    ) : null}
                    {invoice.paidCents > 0 ? (
                        <Row
                            label="Bereits gezahlt"
                            value={-invoice.paidCents}
                        />
                    ) : null}
                    <Row label="Offen" value={outstanding} strong />
                </dl>

                <div className="mt-6 flex flex-wrap gap-4 text-sm">
                    <Link
                        href={`/client/invoices/${invoice.id}/pdf`}
                        className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                    >
                        PDF
                    </Link>
                    <Link
                        href={`/client/invoices/${invoice.id}/xml`}
                        className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground"
                    >
                        XRechnung
                    </Link>
                </div>
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Positionen
                </h2>
                <ul className="max-w-3xl divide-y rounded-lg border text-sm">
                    {items.map((item) => (
                        <li
                            key={item.id}
                            className="flex items-start justify-between gap-6 px-4 py-3"
                        >
                            <span>
                                {item.description}
                                {item.detail ? (
                                    <span className="block text-muted-foreground text-xs">
                                        {item.detail}
                                    </span>
                                ) : null}
                            </span>
                            <span className="shrink-0 font-mono">
                                {formatPrice(
                                    item.netCents ??
                                        item.quantity * item.unitPriceCents,
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>

            {payable ? (
                <div className="border-b px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-6 font-medium text-sm tracking-tight">
                        Bezahlen
                    </h2>

                    <div className="max-w-2xl space-y-8">
                        <PayActions
                            invoiceId={invoice.id}
                            outstandingCents={outstanding}
                            gateways={gateways
                                .filter(
                                    (one) => one.capabilities.hostedCheckout,
                                )
                                .map((one) => ({
                                    id: one.id,
                                    label: one.label,
                                }))}
                            creditCents={Math.min(balance, outstanding)}
                        />

                        {transfer?.kind === "instructions" ? (
                            <div className="rounded-lg border p-4">
                                <h3 className="mb-4 font-medium text-sm">
                                    Überweisung
                                </h3>
                                <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
                                    <dl className="flex-1 space-y-2 text-sm">
                                        <Detail
                                            label="Empfänger"
                                            value={transfer.instructions.holder}
                                        />
                                        <Detail
                                            label="IBAN"
                                            value={transfer.instructions.iban}
                                            mono
                                        />
                                        <Detail
                                            label="BIC"
                                            value={transfer.instructions.bic}
                                            mono
                                        />
                                        <Detail
                                            label="Betrag"
                                            value={formatPrice(outstanding)}
                                            mono
                                        />
                                        <Detail
                                            label="Verwendungszweck"
                                            value={
                                                transfer.instructions.remittance
                                            }
                                            mono
                                        />
                                    </dl>
                                    {transfer.instructions.giroCodeSvg ? (
                                        <figure className="w-36 shrink-0">
                                            {/* Built from a module matrix on
                                                the server: digits and path
                                                commands, with none of the
                                                customer's text in it. */}
                                            <div
                                                className="rounded bg-white p-2"
                                                // biome-ignore lint/security/noDangerouslySetInnerHtml: generated SVG, see above
                                                dangerouslySetInnerHTML={{
                                                    __html: transfer
                                                        .instructions
                                                        .giroCodeSvg,
                                                }}
                                            />
                                            <figcaption className="mt-2 text-center text-muted-foreground text-xs">
                                                GiroCode — mit der Banking-App
                                                scannen
                                            </figcaption>
                                        </figure>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {payments.length > 0 ? (
                <div className="px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-6 font-medium text-sm tracking-tight">
                        Zahlungen
                    </h2>
                    <ul className="max-w-2xl divide-y rounded-lg border text-sm">
                        {payments.map((row) => (
                            <li
                                key={row.id}
                                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                            >
                                <span>
                                    {row.kind === "refund"
                                        ? "Erstattung"
                                        : PAYMENT_PROVIDER_LABEL[row.provider]}
                                    <span className="block text-muted-foreground text-xs">
                                        {formatDate(
                                            row.settledAt ?? row.createdAt,
                                        )}{" "}
                                        · {PAYMENT_STATUS_LABEL[row.status]}
                                    </span>
                                </span>
                                <span className="font-mono">
                                    {row.kind === "refund" ? "−" : ""}
                                    {formatPrice(row.amountCents)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            <div className="px-6 pb-12 md:px-10">
                <Button
                    nativeButton={false}
                    variant="outline"
                    size="lg"
                    render={<Link href="/client/invoices" />}
                >
                    Zurück zu den Rechnungen
                </Button>
            </div>
        </>
    );
}

function Row({
    label,
    value,
    strong,
}: {
    label: string;
    value: number;
    strong?: boolean;
}) {
    return (
        <div className="flex items-center justify-between px-4 py-3">
            <dt className={strong ? "font-medium" : "text-muted-foreground"}>
                {label}
            </dt>
            <dd className={`font-mono ${strong ? "font-medium" : ""}`}>
                {formatPrice(value)}
            </dd>
        </div>
    );
}

function Detail({
    label,
    value,
    mono,
}: {
    label: string;
    value: string;
    mono?: boolean;
}) {
    return (
        <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className={mono ? "font-mono text-sm" : "text-sm"}>{value}</dd>
        </div>
    );
}
