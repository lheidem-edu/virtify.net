import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
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
import {
    earliestTerminationDate,
    minimumTermEnd,
} from "@/lib/documents/contract-term";
import { dateInputValue, priceInputValue } from "@/lib/documents/line-items";
import { formatRecipient, loadContract } from "@/lib/documents/repository";
import {
    CONTRACT_STATUS_LABEL,
    CONTRACT_STATUS_TONE,
    formatDate,
    formatPrice,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
    OFFER_STATUS_LABEL,
    OFFER_STATUS_TONE,
} from "@/lib/format";
import {
    DeleteAction,
    ReactivateAction,
    TerminateAction,
} from "../contract-actions";
import ContractEditForm from "./contract-edit-form";

const linkClass =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm leading-6">{children}</dd>
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

    const loaded = await loadContract(id, session.user.id, true);

    if (!loaded) {
        notFound();
    }

    const { contract, buyer, invoices, offer, paymentMethod } = loaded;

    const termEnd = minimumTermEnd(
        contract.serviceReadyAt,
        contract.minimumTermMonths,
    );
    // Kein Dokument nennt die Konditionen: erst dann sind sie noch frei, und
    // erst dann darf der Vertrag überhaupt verschwinden.
    const isDocumented = invoices.length > 0 || Boolean(offer);
    const isRunning =
        contract.status === "provisioning" || contract.status === "active";

    return (
        <>
            <PageHeader
                title={contract.title}
                intro={`Vertrag für ${buyer.email}.`}
                action={
                    <Button
                        nativeButton={false}
                        render={
                            <Link
                                href={`/account/admin/invoices?contract=${contract.id}`}
                            />
                        }
                    >
                        Rechnung anlegen
                    </Button>
                }
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Vertrag
                </h2>
                <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Status">
                        <StatusBadge
                            label={CONTRACT_STATUS_LABEL[contract.status]}
                            tone={CONTRACT_STATUS_TONE[contract.status]}
                        />
                    </Field>
                    <Field label="Vertrags-Nr.">
                        <span className="font-mono text-xs break-all">
                            {contract.number}
                        </span>
                    </Field>
                    <Field label="Monatlich">
                        <span className="font-mono">
                            {formatPrice(contract.monthlyPriceCents)}
                        </span>
                    </Field>
                    <Field label="Grundlaufzeit">
                        {contract.minimumTermMonths} Monate
                    </Field>
                    <Field label="Service-Readiness">
                        {formatDate(contract.serviceReadyAt)}
                    </Field>
                    <Field label="Ende der Grundlaufzeit">
                        {termEnd ? (
                            formatDate(termEnd)
                        ) : (
                            <span className="text-muted-foreground">
                                Läuft erst ab der Service-Readiness (§ 8 (1)
                                AGB).
                            </span>
                        )}
                    </Field>
                    {contract.terminatedTo ? (
                        <Field label="Gekündigt zum">
                            {formatDate(contract.terminatedTo)}
                        </Field>
                    ) : null}
                    <Field label="Angelegt">
                        {formatDate(contract.createdAt)}
                    </Field>
                    {contract.note ? (
                        <Field label="Interne Notiz">
                            <span className="whitespace-pre-line">
                                {contract.note}
                            </span>
                        </Field>
                    ) : null}
                </dl>
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Konto
                </h2>
                <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Anschrift">
                        <span className="whitespace-pre-line">
                            {formatRecipient(buyer)}
                        </span>
                    </Field>
                    <Field label="E-Mail">{buyer.email}</Field>
                    <Field label="Kundennummer">
                        <span className="font-mono">
                            {buyer.customerNumber ?? "—"}
                        </span>
                    </Field>
                </dl>
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Einzug
                </h2>
                {paymentMethod && !paymentMethod.revokedAt ? (
                    <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                        <Field label="Zahlungsmittel">
                            {paymentMethod.label}
                        </Field>
                        <Field label="Anbieter">
                            {paymentMethod.provider === "stripe"
                                ? "Stripe"
                                : "PayPal"}
                        </Field>
                        <Field label="Hinterlegt seit">
                            {formatDate(paymentMethod.createdAt)}
                        </Field>
                    </dl>
                ) : (
                    <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
                        {paymentMethod?.revokedAt
                            ? `Das hinterlegte Zahlungsmittel wurde am ${formatDate(paymentMethod.revokedAt)} widerrufen. Rechnungen zu diesem Vertrag werden nicht mehr eingezogen.`
                            : "Für diesen Vertrag ist kein Zahlungsmittel hinterlegt. Rechnungen werden vom Kunden selbst überwiesen oder im Kundenbereich bezahlt."}
                    </p>
                )}
                <p className="mt-4 max-w-2xl text-xs leading-6 text-muted-foreground">
                    Die Berechtigung zum Einzug erteilt und widerruft das Konto
                    selbst im Kundenbereich; sie lässt sich hier nicht ändern.
                </p>
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Aktionen
                </h2>
                <div className="flex flex-wrap items-center gap-3">
                    {isRunning ? (
                        <TerminateAction
                            contractId={contract.id}
                            earliestDate={dateInputValue(
                                earliestTerminationDate(contract, new Date()),
                            )}
                        />
                    ) : null}
                    {contract.status === "terminated" ? (
                        <ReactivateAction contractId={contract.id} />
                    ) : null}
                    {isDocumented ? null : (
                        <DeleteAction contractId={contract.id} />
                    )}
                </div>
                {isDocumented ? (
                    <p className="mt-4 max-w-2xl text-xs leading-6 text-muted-foreground">
                        Löschen ist nicht mehr möglich: Rechnung oder Angebot
                        verweisen auf diesen Vertrag und würden den Bezug
                        verlieren.
                    </p>
                ) : null}
            </div>

            {offer ? (
                <div className="border-b px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-6 text-sm font-medium tracking-tight">
                        Aus Angebot entstanden
                    </h2>
                    <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                        <Field label="Angebot">
                            <Link
                                href={`/account/admin/offers/${offer.id}`}
                                className={`font-mono ${linkClass}`}
                            >
                                {offer.number}
                            </Link>
                        </Field>
                        <Field label="Status">
                            <StatusBadge
                                label={
                                    OFFER_STATUS_LABEL[
                                        offer.status as keyof typeof OFFER_STATUS_LABEL
                                    ]
                                }
                                tone={
                                    OFFER_STATUS_TONE[
                                        offer.status as keyof typeof OFFER_STATUS_TONE
                                    ]
                                }
                            />
                        </Field>
                        <Field label="Entschieden am">
                            {formatDate(offer.decidedAt)}
                        </Field>
                    </dl>
                </div>
            ) : null}

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Rechnungen
                </h2>
                {invoices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Für diesen Vertrag wurde noch keine Rechnung angelegt.
                    </p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Nummer</TableHead>
                                    <TableHead>Ausgestellt</TableHead>
                                    <TableHead>Betrag</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {invoices.map((invoice) => (
                                    <TableRow key={invoice.id}>
                                        <TableCell className="font-mono">
                                            {invoice.number ?? "Entwurf"}
                                        </TableCell>
                                        <TableCell>
                                            {formatDate(invoice.issuedAt)}
                                        </TableCell>
                                        <TableCell className="font-mono">
                                            {formatPrice(invoice.amount)}
                                        </TableCell>
                                        <TableCell>
                                            <StatusBadge
                                                label={
                                                    INVOICE_STATUS_LABEL[
                                                        invoice.status as keyof typeof INVOICE_STATUS_LABEL
                                                    ]
                                                }
                                                tone={
                                                    INVOICE_STATUS_TONE[
                                                        invoice.status as keyof typeof INVOICE_STATUS_TONE
                                                    ]
                                                }
                                            />
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Link
                                                href={`/account/admin/invoices/${invoice.id}`}
                                                className={linkClass}
                                            >
                                                Ansehen
                                            </Link>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Vertrag bearbeiten
                </h2>
                <ContractEditForm
                    contractId={contract.id}
                    title={contract.title}
                    status={contract.status}
                    monthlyPrice={priceInputValue(contract.monthlyPriceCents)}
                    minimumTermMonths={contract.minimumTermMonths}
                    serviceReadyAt={dateInputValue(contract.serviceReadyAt)}
                    note={contract.note ?? ""}
                    canEditTerms={!isDocumented}
                />
            </div>
        </>
    );
}
