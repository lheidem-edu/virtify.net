import { asc, eq } from "drizzle-orm";
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
import { db, schema } from "@/db";
import { isOpenInvoice } from "@/db/schema";
import { berlinDay } from "@/lib/berlin-date";
import {
    formatDate,
    formatDateRange,
    formatPrice,
    formatQuantity,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
    PAYMENT_PROVIDER_LABEL,
    PAYMENT_STATUS_LABEL,
    PAYMENT_STATUS_TONE,
} from "@/lib/format";
import { subtract } from "@/lib/money";
import { requirePermission } from "@/server/auth/staff-session";
import { showsTax } from "@/server/billing/invoices/pdf";
import { loadInvoice } from "@/server/billing/invoices/repository";
import { dateInputValue } from "@/server/documents/line-items";
import { formatRate } from "@/server/documents/pdf";
import {
    ANY_CUSTOMER,
    formatRecipient,
    listContracts,
    loadInvoicePayments,
} from "@/server/documents/repository";
import { TAX_STRATEGY_LABEL } from "@/server/tax";
import { manualPaymentToken } from "../../payments/actions";
import { ManualPaymentForm, RefundAction } from "../../payments/payment-forms";
import {
    CancelInvoiceAction,
    DeleteInvoiceAction,
    DuplicateInvoiceAction,
    IssueForm,
    MarkPaidForm,
    ResendMailAction,
    UnmarkPaidForm,
} from "../invoice-actions";
import InvoiceEditForm from "./invoice-edit-form";

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
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-sm leading-6">{children}</dd>
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

    const loaded = await loadInvoice(id, ANY_CUSTOMER, true);
    const payments = await loadInvoicePayments(id, ANY_CUSTOMER, true);

    if (!loaded) {
        notFound();
    }

    const { invoice, items, buyer, totals } = loaded;
    const isDraft = invoice.status === "draft";

    // Corrections are documents of their own now; the invoice knows them by
    // the reference they carry back to it.
    const corrections = loaded.creditNotes;
    const showTax = showsTax(loaded.effectiveTaxStrategy);
    const openCents = Math.max(
        (invoice.grossCents ?? totals.grossCents) - invoice.creditedCents,
        0,
    );

    const [contract] = invoice.contractId
        ? await db
              .select({
                  id: schema.contract.id,
                  number: schema.contract.number,
                  title: schema.contract.title,
              })
              .from(schema.contract)
              .where(eq(schema.contract.id, invoice.contractId))
        : [];

    // Only a draft is editable, so the pickers are only loaded for one.
    const accounts = isDraft
        ? await db
              .select({
                  id: schema.user.id,
                  name: schema.user.name,
                  email: schema.user.email,
              })
              .from(schema.user)
              .orderBy(asc(schema.user.email))
        : [];
    const contracts = isDraft ? await listContracts(ANY_CUSTOMER, true) : [];

    return (
        <>
            <PageHeader
                title={`Rechnung ${invoice.number ?? "(Entwurf)"}`}
                intro={`${buyer.email}${buyer.company ? ` — ${buyer.company}` : ""}`}
                action={
                    <StatusBadge
                        label={INVOICE_STATUS_LABEL[invoice.status]}
                        tone={INVOICE_STATUS_TONE[invoice.status]}
                    />
                }
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Dokument
                </h2>

                <dl className="grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Empfänger">
                        {/* A draft has no frozen block yet — what is shown is
                            the current master data, which issuing will copy. */}
                        <span className="whitespace-pre-line">
                            {invoice.recipient ?? formatRecipient(buyer)}
                        </span>
                        {isDraft ? (
                            <span className="mt-2 block text-xs text-muted-foreground">
                                Wird beim Ausstellen eingefroren.
                            </span>
                        ) : null}
                    </Field>
                    <Field label="Kundennummer">
                        <span className="font-mono">
                            {buyer.customerNumber ?? "—"}
                        </span>
                    </Field>
                    <Field label="Käuferreferenz">
                        <span className="font-mono break-all">
                            {invoice.buyerReference ?? "—"}
                        </span>
                    </Field>
                    <Field label="Ausgestellt">
                        {formatDate(invoice.issuedAt)}
                    </Field>
                    <Field label="Fällig">{formatDate(invoice.dueAt)}</Field>
                    <Field label="Bezahlt">{formatDate(invoice.paidAt)}</Field>
                    <Field label="Korrigiert am">
                        {formatDate(invoice.cancelledAt)}
                    </Field>
                    <Field label="Leistungszeitraum">
                        {formatDateRange(
                            invoice.servicePeriodStart,
                            invoice.servicePeriodEnd,
                        )}
                    </Field>
                    <Field label="Vertrag">
                        {contract ? (
                            <Link
                                href={`/admin/contracts/${contract.id}`}
                                className={LINK}
                            >
                                {contract.number} — {contract.title}
                            </Link>
                        ) : (
                            "—"
                        )}
                    </Field>
                    <Field label="Besteuerung">
                        {invoice.taxStrategy ? (
                            <span>
                                {TAX_STRATEGY_LABEL[
                                    invoice.taxStrategy as keyof typeof TAX_STRATEGY_LABEL
                                ] ?? invoice.taxStrategy}
                            </span>
                        ) : (
                            <span className="text-muted-foreground">
                                Wird beim Ausstellen festgeschrieben.
                            </span>
                        )}
                    </Field>
                    {invoice.creditedCents > 0 ? (
                        <Field label="Korrigiert">
                            <span className="font-mono">
                                {formatPrice(invoice.creditedCents)}
                            </span>
                            <span className="mt-1 block text-muted-foreground text-xs">
                                Offen: {formatPrice(openCents)}
                            </span>
                        </Field>
                    ) : null}
                    {corrections.length > 0 ? (
                        <Field label="Rechnungskorrekturen">
                            {corrections.map((entry) => (
                                <span key={entry.id} className="block">
                                    <Link
                                        href={`/admin/credit-notes/${entry.id}`}
                                        className={`font-mono ${LINK}`}
                                    >
                                        {entry.number}
                                    </Link>{" "}
                                    vom {formatDate(entry.issuedAt)} über{" "}
                                    {formatPrice(entry.grossCents)}
                                </span>
                            ))}
                        </Field>
                    ) : null}
                </dl>

                {invoice.introText ? (
                    <p className="mt-8 max-w-2xl text-sm leading-7 text-muted-foreground">
                        {invoice.introText}
                    </p>
                ) : null}
                {invoice.note ? (
                    <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                        {invoice.note}
                    </p>
                ) : null}
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
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
                                    <TableCell>
                                        {line.description}
                                        {line.detail ? (
                                            <span className="mt-1 block text-xs text-muted-foreground">
                                                {line.detail}
                                            </span>
                                        ) : null}
                                    </TableCell>
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
                            {showTax ? (
                                <>
                                    <TableRow>
                                        <TableCell
                                            colSpan={showTax ? 5 : 4}
                                            className="font-medium"
                                        >
                                            Nettobetrag
                                        </TableCell>
                                        <TableCell className="font-mono">
                                            {formatPrice(totals.netCents)}
                                        </TableCell>
                                    </TableRow>
                                    {totals.groups.map((group) => (
                                        <TableRow
                                            key={`${group.category}-${group.rateBp}`}
                                        >
                                            <TableCell colSpan={5}>
                                                USt. {formatRate(group.rateBp)}{" "}
                                                auf{" "}
                                                {formatPrice(group.netCents)}
                                            </TableCell>
                                            <TableCell className="font-mono">
                                                {formatPrice(group.taxCents)}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </>
                            ) : null}
                            <TableRow>
                                <TableCell
                                    colSpan={showTax ? 5 : 4}
                                    className="font-medium"
                                >
                                    Gesamtbetrag
                                </TableCell>
                                <TableCell className="font-mono font-medium">
                                    {formatPrice(totals.grossCents)}
                                </TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>

                {loaded.taxNotes.map((note) => (
                    <p
                        key={note}
                        className="mt-4 text-xs text-muted-foreground"
                    >
                        {note}
                    </p>
                ))}
            </div>

            {payments.length > 0 ? (
                <div className="border-b px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-6 text-sm font-medium tracking-tight">
                        Zahlungen
                    </h2>
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Anbieter</TableHead>
                                    <TableHead>Quelle</TableHead>
                                    <TableHead className="text-right">
                                        Betrag
                                    </TableHead>
                                    <TableHead className="text-right">
                                        Gebühr
                                    </TableHead>
                                    <TableHead>Referenz</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {payments.map((entry) => (
                                    <TableRow key={entry.id}>
                                        <TableCell>
                                            {
                                                PAYMENT_PROVIDER_LABEL[
                                                    entry.provider
                                                ]
                                            }
                                            {entry.kind === "refund" ? (
                                                <span className="block text-muted-foreground text-xs">
                                                    Erstattung
                                                </span>
                                            ) : null}
                                        </TableCell>
                                        <TableCell>
                                            {entry.methodLabel ? (
                                                <>
                                                    {entry.methodLabel}
                                                    {entry.methodRevokedAt ? (
                                                        <span className="block text-xs text-muted-foreground">
                                                            inzwischen
                                                            widerrufen
                                                        </span>
                                                    ) : null}
                                                </>
                                            ) : (
                                                "Checkout"
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                            {formatPrice(entry.amountCents)}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                            {entry.feeCents === null
                                                ? "—"
                                                : formatPrice(entry.feeCents)}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs break-all">
                                            {entry.captureRef ??
                                                entry.providerRef}
                                        </TableCell>
                                        <TableCell>
                                            <StatusBadge
                                                label={
                                                    PAYMENT_STATUS_LABEL[
                                                        entry.status
                                                    ]
                                                }
                                                tone={
                                                    PAYMENT_STATUS_TONE[
                                                        entry.status
                                                    ]
                                                }
                                            />
                                            <span className="mt-1 block text-xs text-muted-foreground">
                                                {entry.settledAt
                                                    ? formatDate(
                                                          entry.settledAt,
                                                      )
                                                    : `Versuch vom ${formatDate(entry.createdAt)}`}
                                            </span>
                                            {entry.failureMessage ? (
                                                <span className="mt-1 block text-xs text-muted-foreground">
                                                    {entry.failureMessage}
                                                </span>
                                            ) : null}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {entry.kind === "charge" &&
                                            entry.status === "succeeded" ? (
                                                <RefundAction
                                                    paymentId={entry.id}
                                                    amountCents={
                                                        entry.amountCents
                                                    }
                                                    refundableCents={subtract(
                                                        entry.amountCents,
                                                        entry.refundedCents,
                                                    )}
                                                    canCreditNote
                                                />
                                            ) : null}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </div>
            ) : null}

            {isOpenInvoice(invoice.status) ? (
                <div className="border-b px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-2 text-sm font-medium tracking-tight">
                        Zahlungseingang erfassen
                    </h2>
                    <p className="mb-6 max-w-2xl text-muted-foreground text-sm leading-7">
                        Für Geld, das außerhalb eines Zahlungsdienstleisters
                        angekommen ist — eine Überweisung auf dem Kontoauszug
                        etwa. Es wird auf demselben Weg verbucht wie eine
                        Kartenzahlung, damit eine Rechnung nicht zweimal als
                        bezahlt gelten kann.
                    </p>
                    <ManualPaymentForm
                        invoices={[]}
                        fixedInvoiceId={invoice.id}
                        token={await manualPaymentToken()}
                        today={berlinDay(new Date())}
                    />
                </div>
            ) : null}

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Dokumente und Aktionen
                </h2>

                <div className="flex flex-wrap items-start gap-4">
                    <Link
                        href={`/client/invoices/${invoice.id}/pdf`}
                        className={`text-sm ${LINK}`}
                    >
                        PDF
                    </Link>
                    {isDraft ? null : (
                        <Link
                            href={`/client/invoices/${invoice.id}/xml`}
                            className={`text-sm ${LINK}`}
                        >
                            XRechnung (XML)
                        </Link>
                    )}

                    {isDraft ? (
                        <>
                            <IssueForm invoiceId={invoice.id} />
                            <DeleteInvoiceAction invoiceId={invoice.id} />
                        </>
                    ) : (
                        <>
                            {isOpenInvoice(invoice.status) ? (
                                <MarkPaidForm
                                    invoiceId={invoice.id}
                                    token={await manualPaymentToken()}
                                />
                            ) : null}
                            {invoice.status === "paid" ? (
                                <UnmarkPaidForm invoiceId={invoice.id} />
                            ) : null}
                            <DuplicateInvoiceAction invoiceId={invoice.id} />
                            {isOpenInvoice(invoice.status) ||
                            invoice.status === "paid" ? (
                                <ResendMailAction
                                    invoiceId={invoice.id}
                                    email={buyer.email}
                                />
                            ) : null}
                            {/* A fully corrected invoice has nothing left to
                                take back, so the action disappears with it. */}
                            {invoice.number &&
                            invoice.status !== "cancelled" &&
                            openCents > 0 ? (
                                <CancelInvoiceAction
                                    invoiceId={invoice.id}
                                    number={invoice.number}
                                />
                            ) : null}
                        </>
                    )}
                </div>
            </div>

            {isDraft ? (
                <div className="px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-6 text-sm font-medium tracking-tight">
                        Entwurf bearbeiten
                    </h2>
                    <InvoiceEditForm
                        accounts={accounts}
                        contracts={contracts.map((entry) => ({
                            id: entry.id,
                            number: entry.number,
                            title: entry.title,
                            email: entry.email,
                        }))}
                        invoice={{
                            id: invoice.id,
                            customerId: invoice.customerId,
                            contractId: invoice.contractId ?? "",
                            introText: invoice.introText ?? "",
                            note: invoice.note ?? "",
                            servicePeriodStart: dateInputValue(
                                invoice.servicePeriodStart,
                            ),
                            servicePeriodEnd: dateInputValue(
                                invoice.servicePeriodEnd,
                            ),
                            items: items.map((item) => ({
                                description: item.description,
                                detail: item.detail,
                                quantity: item.quantity,
                                unitCode: item.unitCode,
                                unitPriceCents: item.unitPriceCents,
                            })),
                        }}
                    />
                </div>
            ) : null}
        </>
    );
}
