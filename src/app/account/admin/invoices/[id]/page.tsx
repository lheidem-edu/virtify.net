import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { db, schema } from "@/lib/db";
import { dateInputValue } from "@/lib/documents/line-items";
import {
    formatRecipient,
    listContracts,
    loadInvoice,
    loadInvoicePayments,
} from "@/lib/documents/repository";
import {
    formatDate,
    formatDateRange,
    formatPrice,
    formatQuantity,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
} from "@/lib/format";
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

/**
 * Payment vocabulary lives here rather than in src/lib/format.ts because it is
 * only ever read by the operator — the customer sees the invoice's own status.
 */
const PROVIDER_LABEL = { stripe: "Stripe", paypal: "PayPal" } as const;

const PAYMENT_STATUS_LABEL = {
    pending: "Offen",
    processing: "In Abwicklung",
    succeeded: "Bezahlt",
    failed: "Fehlgeschlagen",
    refunded: "Erstattet",
} as const;

const PAYMENT_STATUS_TONE = {
    pending: "muted",
    processing: "warning",
    succeeded: "positive",
    failed: "warning",
    refunded: "neutral",
} as const;

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
    const session = await requireAdmin();
    const { id } = await params;

    const loaded = await loadInvoice(id, session.user.id, true);
    const payments = await loadInvoicePayments(id, session.user.id, true);

    if (!loaded) {
        notFound();
    }

    const { invoice, items, buyer, totals } = loaded;
    const isDraft = invoice.status === "draft";

    // Both directions of the correction pair: the invoice this one reverses,
    // the one that reversed it. Neither is reachable from the row itself.
    const [cancels] = invoice.cancelsInvoiceId
        ? await db
              .select({
                  id: schema.invoice.id,
                  number: schema.invoice.number,
                  issuedAt: schema.invoice.issuedAt,
              })
              .from(schema.invoice)
              .where(eq(schema.invoice.id, invoice.cancelsInvoiceId))
        : [];

    const [cancelledBy] = await db
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            issuedAt: schema.invoice.issuedAt,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.cancelsInvoiceId, invoice.id));

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
    const contracts = isDraft ? await listContracts(session.user.id, true) : [];

    return (
        <>
            <PageHeader
                title={
                    cancels
                        ? `Rechnungskorrektur ${invoice.number}`
                        : `Rechnung ${invoice.number ?? "(Entwurf)"}`
                }
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
                                href={`/account/admin/contracts/${contract.id}`}
                                className={LINK}
                            >
                                {contract.number} — {contract.title}
                            </Link>
                        ) : (
                            "—"
                        )}
                    </Field>
                    {cancels ? (
                        <Field label="Korrigiert Rechnung">
                            <Link
                                href={`/account/admin/invoices/${cancels.id}`}
                                className={`font-mono ${LINK}`}
                            >
                                {cancels.number}
                            </Link>{" "}
                            vom {formatDate(cancels.issuedAt)}
                        </Field>
                    ) : null}
                    {cancelledBy ? (
                        <Field label="Korrigiert durch">
                            <Link
                                href={`/account/admin/invoices/${cancelledBy.id}`}
                                className={`font-mono ${LINK}`}
                            >
                                {cancelledBy.number}
                            </Link>{" "}
                            vom {formatDate(cancelledBy.issuedAt)}
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
                                <TableHead>Gesamt</TableHead>
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
                                    <TableCell className="font-mono">
                                        {formatPrice(line.lineTotalCents)}
                                    </TableCell>
                                </TableRow>
                            ))}
                            <TableRow>
                                <TableCell colSpan={4} className="font-medium">
                                    Gesamtbetrag
                                </TableCell>
                                <TableCell className="font-mono font-medium">
                                    {formatPrice(totals.grossCents)}
                                </TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>

                <p className="mt-4 text-xs text-muted-foreground">
                    Kein Ausweis der Umsatzsteuer nach § 19 UStG.
                </p>
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
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {payments.map((entry) => (
                                    <TableRow key={entry.id}>
                                        <TableCell>
                                            {PROVIDER_LABEL[entry.provider]}
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
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </div>
            ) : null}

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Dokumente und Aktionen
                </h2>

                <div className="flex flex-wrap items-start gap-4">
                    <Link
                        href={`/account/invoices/${invoice.id}/pdf`}
                        className={`text-sm ${LINK}`}
                    >
                        PDF
                    </Link>
                    {isDraft ? null : (
                        <Link
                            href={`/account/invoices/${invoice.id}/xml`}
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
                            {/* A correction settles the original — there is
                                nothing on it left to pay. */}
                            {invoice.status === "issued" && !cancels ? (
                                <MarkPaidForm invoiceId={invoice.id} />
                            ) : null}
                            {invoice.status === "paid" ? (
                                <UnmarkPaidForm invoiceId={invoice.id} />
                            ) : null}
                            <DuplicateInvoiceAction invoiceId={invoice.id} />
                            {invoice.status === "issued" ||
                            invoice.status === "paid" ? (
                                <ResendMailAction
                                    invoiceId={invoice.id}
                                    email={buyer.email}
                                />
                            ) : null}
                            {invoice.number &&
                            !cancels &&
                            !cancelledBy &&
                            (invoice.status === "issued" ||
                                invoice.status === "paid") ? (
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
                            userId: invoice.userId,
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
