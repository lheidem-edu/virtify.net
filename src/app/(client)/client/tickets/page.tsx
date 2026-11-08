import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import {
    formatDateTime,
    TICKET_STATUS_LABEL,
    TICKET_STATUS_TONE,
} from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { formatTicketNumber } from "@/server/tickets/numbering";
import { listTickets } from "@/server/tickets/repository";

export default async function Page() {
    const { customer } = await getCurrentCustomer();
    const page = await listTickets(customer.id, { limit: 100 }, db);

    return (
        <>
            <PageHeader
                title="Tickets"
                intro="Deine Anfragen an den Support. Du kannst hier antworten oder einfach auf die Bestätigungsmail — die Kennzeichnung im Betreff führt die Antwort zum selben Vorgang zurück."
                action={
                    <Button render={<Link href="/client/tickets/new" />}>
                        Neues Ticket
                    </Button>
                }
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {page.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Du hast noch kein Ticket eröffnet.
                    </p>
                ) : (
                    <ul className="space-y-3">
                        {page.rows.map((row) => (
                            <li key={row.id}>
                                <Link
                                    href={`/client/tickets/${row.id}`}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4 transition-colors hover:border-ring"
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm">
                                            {row.subject}
                                        </span>
                                        <span className="mt-1 block text-xs text-muted-foreground">
                                            {formatTicketNumber(row.number)} ·{" "}
                                            {row.departmentName} · zuletzt{" "}
                                            {formatDateTime(row.lastMessageAt)}
                                        </span>
                                    </span>
                                    <StatusBadge
                                        label={TICKET_STATUS_LABEL[row.status]}
                                        tone={TICKET_STATUS_TONE[row.status]}
                                    />
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
