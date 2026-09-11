import { asc } from "drizzle-orm";
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
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { db, schema } from "@/lib/db";
import {
    ANY_CUSTOMER,
    loadContract,
    loadOffer,
} from "@/lib/documents/repository";
import {
    CONTRACT_STATUS_LABEL,
    formatDate,
    formatPrice,
    formatQuantity,
    OFFER_STATUS_LABEL,
    OFFER_STATUS_TONE,
} from "@/lib/format";
import { requireStaff } from "@/lib/staff-session";
import {
    AcceptForCustomerAction,
    DeleteOfferAction,
    RecordDecisionAction,
    ResendOfferAction,
    SendOfferAction,
    WithdrawOfferAction,
} from "../offer-actions";
import OfferEditForm from "./offer-edit-form";

const LINK =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

function Fact({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm">{children}</dd>
        </div>
    );
}

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requireStaff();
    const { id } = await params;

    const loaded = await loadOffer(id, ANY_CUSTOMER, true);

    if (!loaded) {
        notFound();
    }

    const { offer, items, buyer, totals } = loaded;
    const status = offer.status as keyof typeof OFFER_STATUS_LABEL;

    // Only the draft is editable, so the account list is only fetched for one.
    const accounts =
        offer.status === "draft"
            ? await db
                  .select({
                      id: schema.user.id,
                      name: schema.user.name,
                      email: schema.user.email,
                  })
                  .from(schema.user)
                  .orderBy(asc(schema.user.email))
            : [];

    const contract = offer.contractId
        ? await loadContract(offer.contractId, ANY_CUSTOMER, true)
        : null;

    return (
        <>
            <PageHeader
                title={`Angebot ${offer.number}`}
                intro={offer.title}
                action={
                    <StatusBadge
                        label={OFFER_STATUS_LABEL[status]}
                        tone={OFFER_STATUS_TONE[status]}
                    />
                }
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Angebot
                </h2>

                <dl className="grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    <Fact label="Konto">
                        {buyer.email}
                        {buyer.customerNumber ? (
                            <span className="text-muted-foreground">
                                {" "}
                                · {buyer.customerNumber}
                            </span>
                        ) : null}
                    </Fact>
                    <Fact label="Empfänger">
                        <span className="whitespace-pre-line leading-6">
                            {offer.recipient ??
                                "Wird beim Versenden aus den Stammdaten übernommen."}
                        </span>
                    </Fact>
                    <Fact label="Monatliche Vergütung">
                        <span className="font-mono">
                            {formatPrice(offer.monthlyPriceCents)}
                        </span>
                    </Fact>
                    <Fact label="Grundlaufzeit">
                        {offer.minimumTermMonths === 0
                            ? "Ohne Grundlaufzeit"
                            : `${offer.minimumTermMonths} Monate`}
                    </Fact>
                    <Fact label="Gültig bis">
                        {formatDate(offer.validUntil)}
                    </Fact>
                    <Fact label="Versendet am">{formatDate(offer.sentAt)}</Fact>
                    <Fact label="Entschieden am">
                        {formatDate(offer.decidedAt)}
                    </Fact>
                    <Fact label="Vertrag">
                        {contract ? (
                            <Link
                                href={`/admin/contracts/${contract.contract.id}`}
                                className={`font-mono ${LINK}`}
                            >
                                {contract.contract.number}
                            </Link>
                        ) : (
                            "—"
                        )}
                        {contract ? (
                            <span className="text-muted-foreground">
                                {" "}
                                ·{" "}
                                {
                                    CONTRACT_STATUS_LABEL[
                                        contract.contract.status
                                    ]
                                }
                            </span>
                        ) : null}
                    </Fact>
                </dl>

                {offer.introText ? (
                    <p className="mt-8 max-w-2xl text-sm leading-7 text-muted-foreground">
                        {offer.introText}
                    </p>
                ) : null}
                {offer.note ? (
                    <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                        {offer.note}
                    </p>
                ) : null}
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Positionen
                </h2>

                <div className="max-w-4xl overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-10">Pos.</TableHead>
                                <TableHead>Bezeichnung</TableHead>
                                <TableHead>Menge</TableHead>
                                <TableHead className="text-right">
                                    Einzelpreis
                                </TableHead>
                                <TableHead className="text-right">
                                    Summe
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {totals.lines.map((line) => (
                                <TableRow key={line.position}>
                                    <TableCell className="text-muted-foreground">
                                        {line.position}
                                    </TableCell>
                                    <TableCell className="whitespace-normal">
                                        {line.description}
                                        {line.detail ? (
                                            <span className="block text-xs text-muted-foreground">
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
                                    <TableCell className="text-right font-mono">
                                        {formatPrice(line.unitPriceCents)}
                                    </TableCell>
                                    <TableCell className="text-right font-mono">
                                        {formatPrice(line.lineTotalCents)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>

                <p className="mt-6 flex max-w-4xl items-center justify-between text-sm">
                    <span>Gesamt</span>
                    <span className="font-mono">
                        {formatPrice(totals.grossCents)}
                    </span>
                </p>
                <p className="mt-2 max-w-4xl text-xs text-muted-foreground">
                    Kein Ausweis der Umsatzsteuer nach § 19 UStG.
                </p>
            </div>

            <div
                className={
                    offer.status === "draft"
                        ? "border-b px-6 py-10 md:px-10 md:py-12"
                        : "px-6 py-10 md:px-10 md:py-12"
                }
            >
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Aktionen
                </h2>

                <div className="flex flex-wrap items-start gap-4">
                    <Link
                        href={`/account/offers/${offer.id}/pdf`}
                        className={`text-sm ${LINK}`}
                    >
                        PDF ansehen
                    </Link>

                    {offer.status === "draft" ? (
                        <>
                            <SendOfferAction offerId={offer.id} />
                            <DeleteOfferAction
                                offerId={offer.id}
                                number={offer.number}
                            />
                        </>
                    ) : null}

                    {offer.status === "sent" ? (
                        <>
                            <ResendOfferAction offerId={offer.id} />
                            <AcceptForCustomerAction offerId={offer.id} />
                            <WithdrawOfferAction offerId={offer.id} />
                            <RecordDecisionAction offerId={offer.id} />
                        </>
                    ) : null}
                </div>

                {offer.status === "sent" ? (
                    <p className="mt-6 max-w-2xl text-xs leading-6 text-muted-foreground">
                        Die Annahme für den Kunden schließt den Vertrag in
                        seinem Namen. Abgelehnt und abgelaufen halten nur fest,
                        was ohnehin geschehen ist, und lösen keine E-Mail aus.
                    </p>
                ) : null}
            </div>

            {offer.status === "draft" ? (
                <div className="px-6 py-10 md:px-10 md:py-12">
                    <h2 className="mb-6 text-sm font-medium tracking-tight">
                        Entwurf bearbeiten
                    </h2>
                    <OfferEditForm
                        offerId={offer.id}
                        accounts={accounts}
                        offer={{
                            userId: offer.userId,
                            title: offer.title,
                            introText: offer.introText,
                            note: offer.note,
                            validUntil: offer.validUntil,
                            monthlyPriceCents: offer.monthlyPriceCents,
                            minimumTermMonths: offer.minimumTermMonths,
                        }}
                        items={items.map((item) => ({
                            description: item.description,
                            detail: item.detail,
                            quantity: item.quantity,
                            unitCode: item.unitCode,
                            unitPriceCents: item.unitPriceCents,
                        }))}
                    />
                </div>
            ) : null}
        </>
    );
}
