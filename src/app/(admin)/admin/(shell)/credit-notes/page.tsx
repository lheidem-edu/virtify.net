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
import { CREDIT_NOTE_KIND_LABEL, formatDate, formatPrice } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listCreditNotes } from "@/server/billing/invoices/repository";
import { ANY_CUSTOMER } from "@/server/documents/repository";

export const dynamic = "force-dynamic";

const LINK =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

/**
 * Rechnungskorrekturen, on their own list because they are documents of their
 * own: own number range, own PDF, own XRechnung. The invoice they correct is
 * one click away, and so is the way back.
 */
export default async function Page() {
    await requirePermission("billing.read");

    const rows = await listCreditNotes(ANY_CUSTOMER, true);

    return (
        <>
            <PageHeader
                title="Rechnungskorrekturen"
                intro="Jede Korrektur trägt eine eigene, lückenlose Nummer aus der RK-Reihe und verweist auf die Rechnung, die sie zurücknimmt."
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {rows.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                        Es gibt noch keine Rechnungskorrekturen.
                    </p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Nummer</TableHead>
                                    <TableHead>Konto</TableHead>
                                    <TableHead>Datum</TableHead>
                                    <TableHead>Korrigiert</TableHead>
                                    <TableHead>Umfang</TableHead>
                                    <TableHead className="text-right">
                                        Betrag
                                    </TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => (
                                    <TableRow key={row.id}>
                                        <TableCell className="font-mono">
                                            <Link
                                                href={`/admin/credit-notes/${row.id}`}
                                                className={LINK}
                                            >
                                                {row.number}
                                            </Link>
                                        </TableCell>
                                        <TableCell>{row.email}</TableCell>
                                        <TableCell>
                                            {formatDate(row.issuedAt)}
                                        </TableCell>
                                        <TableCell className="font-mono">
                                            <Link
                                                href={`/admin/invoices/${row.invoiceId}`}
                                                className={LINK}
                                            >
                                                {row.invoiceNumber ?? "—"}
                                            </Link>
                                        </TableCell>
                                        <TableCell>
                                            <StatusBadge
                                                label={
                                                    CREDIT_NOTE_KIND_LABEL[
                                                        row.kind as keyof typeof CREDIT_NOTE_KIND_LABEL
                                                    ] ?? row.kind
                                                }
                                                tone="neutral"
                                            />
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                            {formatPrice(row.grossCents)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Link
                                                href={`/client/credit-notes/${row.id}/pdf`}
                                                className={LINK}
                                            >
                                                PDF
                                            </Link>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </div>
        </>
    );
}
