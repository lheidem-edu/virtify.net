import Link from "next/link";
import { notFound } from "next/navigation";
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
import {
    CREDIT_NOTE_KIND_LABEL,
    formatDate,
    formatDateRange,
    formatPrice,
    formatQuantity,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { showsTax } from "@/server/billing/invoices/pdf";
import { loadCreditNote } from "@/server/billing/invoices/repository";
import { formatRate } from "@/server/documents/pdf";
import { ANY_CUSTOMER } from "@/server/documents/repository";
import { TAX_STRATEGY_LABEL } from "@/server/tax";
import { ResendCreditNoteAction } from "./actions-client";

export const dynamic = "force-dynamic";

const LINK =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                {label}
            </dt>
            <dd className="mt-1 text-sm">{children}</dd>
        </div>
    );
}

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requirePermission("billing.read");

    const { id } = await params;
    const loaded = await loadCreditNote(id, ANY_CUSTOMER, true, db);

    if (!loaded) {
        notFound();
    }

    const { creditNote, totals, invoice } = loaded;
    const showTax = showsTax(creditNote.taxStrategy);

    return (
        <>
            <PageHeader
                title={`Rechnungskorrektur ${creditNote.number}`}
                intro={
                    invoice?.number
                        ? `Korrigiert Rechnung ${invoice.number} vom ${formatDate(invoice.issuedAt)}`
                        : undefined
                }
                action={
                    <StatusBadge
                        label={
                            CREDIT_NOTE_KIND_LABEL[
                                creditNote.kind as keyof typeof CREDIT_NOTE_KIND_LABEL
                            ] ?? creditNote.kind
                        }
                        tone="neutral"
                    />
                }
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Dokument
                </h2>

                <dl className="grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Empfänger">
                        <span className="whitespace-pre-line">
                            {creditNote.recipient ?? "—"}
                        </span>
                    </Field>
                    <Field label="Kundennummer">
                        <span className="font-mono">
                            {creditNote.buyerCustomerNumber ?? "—"}
                        </span>
                    </Field>
                    <Field label="Datum">
                        {formatDate(creditNote.issuedAt)}
                    </Field>
                    <Field label="Korrigierte Rechnung">
                        {invoice ? (
                            <Link
                                href={`/admin/invoices/${invoice.id}`}
                                className={`font-mono ${LINK}`}
                            >
                                {invoice.number}
                            </Link>
                        ) : (
                            "—"
                        )}
                    </Field>
                    <Field label="Leistungszeitraum">
                        {formatDateRange(
                            creditNote.servicePeriodStart,
                            creditNote.servicePeriodEnd,
                        )}
                    </Field>
                    <Field label="Besteuerung">
                        {TAX_STRATEGY_LABEL[
                            creditNote.taxStrategy as keyof typeof TAX_STRATEGY_LABEL
                        ] ?? creditNote.taxStrategy}
                    </Field>
                </dl>

                {creditNote.reason ? (
                    <p className="mt-8 max-w-2xl text-muted-foreground text-sm leading-7">
                        {creditNote.reason}
                    </p>
                ) : null}
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Positionen
                </h2>

                <div className="max-w-4xl overflow-x-auto rounded-lg border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Pos.</TableHead>
                                <TableHead>Bezeichnung</TableHead>
                                <TableHead>Menge</TableHead>
                                <TableHead>Einzelpreis</TableHead>
                                {showTax ? <TableHead>USt.</TableHead> : null}
                                <TableHead>Netto</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {totals.lines.map((line) => (
                                <TableRow key={line.position}>
                                    <TableCell className="font-mono">
                                        {line.position}
                                    </TableCell>
                                    <TableCell>{line.description}</TableCell>
                                    <TableCell>
                                        {formatQuantity(
                                            line.quantity,
                                            line.unitCode,
                                        )}
                                    </TableCell>
                                    <TableCell className="font-mono">
                                        {formatPrice(line.unitPriceCents)}
                                    </TableCell>
                                    {showTax ? (
                                        <TableCell className="font-mono">
                                            {formatRate(line.taxRateBp)}
                                        </TableCell>
                                    ) : null}
                                    <TableCell className="font-mono">
                                        {formatPrice(line.netCents)}
                                    </TableCell>
                                </TableRow>
                            ))}
                            <TableRow>
                                <TableCell
                                    colSpan={showTax ? 5 : 4}
                                    className="font-medium"
                                >
                                    Gutgeschriebener Betrag
                                </TableCell>
                                <TableCell className="font-mono font-medium">
                                    {formatPrice(totals.grossCents)}
                                </TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>

                {creditNote.taxNote ? (
                    <p className="mt-4 text-muted-foreground text-xs">
                        {creditNote.taxNote}
                    </p>
                ) : null}
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Dokumente
                </h2>
                <div className="flex flex-wrap items-center gap-6">
                    <Link
                        href={`/client/credit-notes/${creditNote.id}/pdf`}
                        className={`text-sm ${LINK}`}
                    >
                        PDF
                    </Link>
                    <Link
                        href={`/client/credit-notes/${creditNote.id}/xml`}
                        className={`text-sm ${LINK}`}
                    >
                        XRechnung (XML)
                    </Link>
                    <ResendCreditNoteAction
                        creditNoteId={creditNote.id}
                        email={creditNote.buyerEmail ?? ""}
                    />
                </div>
            </div>
        </>
    );
}
