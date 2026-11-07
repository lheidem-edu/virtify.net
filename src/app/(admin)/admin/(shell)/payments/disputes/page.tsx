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
import {
    DISPUTE_STATUS_LABEL,
    DISPUTE_STATUS_TONE,
    formatDate,
    formatPrice,
    PAYMENT_PROVIDER_LABEL,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listDisputes } from "@/server/payments/disputes";

export const dynamic = "force-dynamic";

const LINK =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

/**
 * Chargebacks.
 *
 * Nothing here moves money, and that is deliberate: a dispute that is *lost*
 * reverses the payment, and the provider reports that reversal as its own
 * event, which is booked as an ordinary refund. Deciding it here as well
 * would book it twice.
 *
 * The evidence goes in at the provider — neither Stripe nor PayPal accepts it
 * any other way — so this page exists to make sure the deadline is not the
 * thing that is missed.
 */
export default async function Page() {
    await requirePermission("payments.read");

    const rows = await listDisputes(db);

    return (
        <>
            <PageHeader
                title="Angefochtene Zahlungen"
                intro="Fälle, in denen ein Zahlungsdienstleister eine Zahlung zurückfordert. Die Stellungnahme reichst du beim Anbieter selbst ein; hier steht, bis wann."
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {rows.length === 0 ? (
                    <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                        Es ist keine Zahlung angefochten worden.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Eröffnet</TableHead>
                                    <TableHead>Kunde</TableHead>
                                    <TableHead>Rechnung</TableHead>
                                    <TableHead>Anbieter</TableHead>
                                    <TableHead className="text-right">
                                        Betrag
                                    </TableHead>
                                    <TableHead>Grund</TableHead>
                                    <TableHead>Frist</TableHead>
                                    <TableHead>Status</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map(
                                    ({
                                        dispute,
                                        payment,
                                        invoiceNumber,
                                        customerName,
                                    }) => (
                                        <TableRow key={dispute.id}>
                                            <TableCell className="whitespace-nowrap">
                                                {formatDate(dispute.openedAt)}
                                            </TableCell>
                                            <TableCell>
                                                {customerName ?? "—"}
                                            </TableCell>
                                            <TableCell>
                                                {payment.invoiceId ? (
                                                    <Link
                                                        href={`/admin/invoices/${payment.invoiceId}`}
                                                        className={`${LINK} font-mono`}
                                                    >
                                                        {invoiceNumber ?? "—"}
                                                    </Link>
                                                ) : (
                                                    "—"
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {
                                                    PAYMENT_PROVIDER_LABEL[
                                                        dispute.provider
                                                    ]
                                                }
                                            </TableCell>
                                            <TableCell className="text-right font-mono">
                                                {formatPrice(
                                                    dispute.amountCents,
                                                )}
                                            </TableCell>
                                            <TableCell className="text-muted-foreground text-xs">
                                                {dispute.reason ?? "—"}
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap">
                                                {dispute.respondBy
                                                    ? formatDate(
                                                          dispute.respondBy,
                                                      )
                                                    : "—"}
                                            </TableCell>
                                            <TableCell>
                                                <StatusBadge
                                                    label={
                                                        DISPUTE_STATUS_LABEL[
                                                            dispute.status
                                                        ]
                                                    }
                                                    tone={
                                                        DISPUTE_STATUS_TONE[
                                                            dispute.status
                                                        ]
                                                    }
                                                />
                                            </TableCell>
                                        </TableRow>
                                    ),
                                )}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </div>
        </>
    );
}
