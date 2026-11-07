import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { db } from "@/db";
import { berlinDay } from "@/lib/berlin-date";
import {
    formatDate,
    formatPrice,
    PAYMENT_PROVIDER_LABEL,
    PAYMENT_STATUS_LABEL,
    PAYMENT_STATUS_TONE,
} from "@/lib/format";
import { subtract } from "@/lib/money";
import { requirePermission } from "@/server/auth/staff-session";
import { listDisputes } from "@/server/payments/disputes";
import { gatewayFor } from "@/server/payments/gateways";
import {
    listTransactions,
    openInvoicesFor,
} from "@/server/payments/repository";
import { manualPaymentToken } from "./actions";
import { ManualPaymentForm, RefundAction } from "./payment-forms";

export const dynamic = "force-dynamic";

const LINK =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

/**
 * Every movement of money, in one list.
 *
 * Charges and refunds are rows of the same table, which is what makes the
 * page readable: a refunded charge and its refund sit next to each other and
 * add up to what was actually kept, instead of one of them being a status on
 * the other.
 */
export default async function Page() {
    await requirePermission("payments.read");

    const [transactions, invoices, disputes, token] = await Promise.all([
        listTransactions(db),
        openInvoicesFor(db),
        listDisputes(db, 5),
        manualPaymentToken(),
    ]);

    const openDisputes = disputes.filter(
        (entry) =>
            entry.dispute.status === "open" ||
            entry.dispute.status === "under_review",
    );

    return (
        <>
            <PageHeader
                title="Zahlungen"
                intro="Jeder Ein- und Ausgang, von welchem Weg auch immer. Was eine Rechnung schuldet, sagt die Rechnung; hier steht, was tatsächlich geflossen ist."
            />

            {openDisputes.length > 0 ? (
                <div className="border-b bg-amber-950/20 px-6 py-6 md:px-10">
                    <p className="text-sm">
                        {openDisputes.length === 1
                            ? "Ein Fall ist offen"
                            : `${openDisputes.length} Fälle sind offen`}
                        , bei denen eine Zahlung angefochten wurde.{" "}
                        <Link href="/admin/payments/disputes" className={LINK}>
                            Ansehen
                        </Link>
                    </p>
                </div>
            ) : null}

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Zahlungseingang erfassen
                </h2>
                <ManualPaymentForm
                    token={token}
                    today={berlinDay(new Date())}
                    invoices={invoices.map((invoice) => {
                        const outstanding = subtract(
                            Math.max(
                                subtract(
                                    invoice.grossCents ?? 0,
                                    invoice.creditedCents,
                                ),
                                0,
                            ),
                            invoice.paidCents,
                        );

                        return {
                            id: invoice.id,
                            outstandingCents: outstanding,
                            label: `${invoice.number ?? invoice.id} — ${invoice.customerName} — ${formatPrice(outstanding)} offen`,
                        };
                    })}
                />
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Vorgänge
                </h2>

                {transactions.length === 0 ? (
                    <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                        Es ist noch kein Geld geflossen.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Datum</TableHead>
                                    <TableHead>Kunde</TableHead>
                                    <TableHead>Rechnung</TableHead>
                                    <TableHead>Weg</TableHead>
                                    <TableHead className="text-right">
                                        Betrag
                                    </TableHead>
                                    <TableHead className="text-right">
                                        Gebühr
                                    </TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {transactions.map((row) => {
                                    const refundable = subtract(
                                        row.amountCents,
                                        row.refundedCents,
                                    );
                                    const gateway = gatewayFor(row.provider);

                                    return (
                                        <TableRow key={row.id}>
                                            <TableCell className="whitespace-nowrap">
                                                {formatDate(
                                                    row.settledAt ??
                                                        row.createdAt,
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {row.customerName ?? "—"}
                                                {row.customerNumber ? (
                                                    <span className="block font-mono text-muted-foreground text-xs">
                                                        {row.customerNumber}
                                                    </span>
                                                ) : null}
                                            </TableCell>
                                            <TableCell>
                                                {row.invoiceId ? (
                                                    <Link
                                                        href={`/admin/invoices/${row.invoiceId}`}
                                                        className={`${LINK} font-mono`}
                                                    >
                                                        {row.invoiceNumber ??
                                                            "Entwurf"}
                                                    </Link>
                                                ) : (
                                                    <span className="text-muted-foreground">
                                                        Guthaben
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {
                                                    PAYMENT_PROVIDER_LABEL[
                                                        row.provider
                                                    ]
                                                }
                                                {row.methodLabel ? (
                                                    <span className="block text-muted-foreground text-xs">
                                                        {row.methodLabel}
                                                    </span>
                                                ) : null}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                                {row.kind === "refund"
                                                    ? "−"
                                                    : ""}
                                                {formatPrice(row.amountCents)}
                                                {row.refundedCents > 0 &&
                                                row.kind === "charge" ? (
                                                    <span className="block text-muted-foreground text-xs">
                                                        {formatPrice(
                                                            row.refundedCents,
                                                        )}{" "}
                                                        erstattet
                                                    </span>
                                                ) : null}
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                                {row.feeCents === null
                                                    ? "—"
                                                    : formatPrice(row.feeCents)}
                                            </TableCell>
                                            <TableCell>
                                                <StatusBadge
                                                    label={
                                                        PAYMENT_STATUS_LABEL[
                                                            row.status
                                                        ]
                                                    }
                                                    tone={
                                                        PAYMENT_STATUS_TONE[
                                                            row.status
                                                        ]
                                                    }
                                                />
                                                {row.failureCode ? (
                                                    <span className="mt-1 block text-muted-foreground text-xs">
                                                        {row.failureCode}
                                                    </span>
                                                ) : null}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {row.kind === "charge" &&
                                                row.status === "succeeded" ? (
                                                    <RefundAction
                                                        paymentId={row.id}
                                                        amountCents={
                                                            row.amountCents
                                                        }
                                                        refundableCents={
                                                            refundable
                                                        }
                                                        canCreditNote={
                                                            row.invoiceId !==
                                                            null
                                                        }
                                                    />
                                                ) : null}
                                                {row.kind === "charge" &&
                                                row.status === "succeeded" &&
                                                !gateway?.capabilities
                                                    .refunds ? (
                                                    <span className="block text-muted-foreground text-xs">
                                                        Rückzahlung von Hand
                                                    </span>
                                                ) : null}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </div>
        </>
    );
}
