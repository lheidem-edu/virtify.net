import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import type { TicketStatus } from "@/db/schema";
import {
    formatDateTime,
    TICKET_PRIORITY_LABEL,
    TICKET_PRIORITY_TONE,
    TICKET_STATUS_LABEL,
    TICKET_STATUS_TONE,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listDepartments } from "@/server/tickets/departments";
import { formatTicketNumber } from "@/server/tickets/numbering";
import {
    ANY_CUSTOMER,
    listTickets,
    ticketCounts,
} from "@/server/tickets/repository";
import SweepButton from "./sweep-button";

const FILTERS = [
    { href: "/admin/tickets", label: "Alle offenen" },
    { href: "/admin/tickets?status=open", label: "Offen" },
    { href: "/admin/tickets?status=waiting", label: "Wartet auf Kunden" },
    { href: "/admin/tickets?status=on_hold", label: "Zurückgestellt" },
    { href: "/admin/tickets?status=closed", label: "Geschlossen" },
    { href: "/admin/tickets?unknown=1", label: "Unbekannter Absender" },
];

const STATUSES: TicketStatus[] = ["open", "waiting", "on_hold", "closed"];

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{
        status?: string;
        department?: string;
        unknown?: string;
    }>;
}) {
    await requirePermission("tickets.read");

    const { status, department, unknown } = await searchParams;
    const filter = STATUSES.find((entry) => entry === status);

    const [page, counts, departments] = await Promise.all([
        listTickets(
            ANY_CUSTOMER,
            {
                status: filter ?? "open-ish",
                departmentId: department,
                unknownSenderOnly: unknown === "1",
                limit: 100,
            },
            db,
        ),
        ticketCounts(db),
        listDepartments(db),
    ]);

    return (
        <>
            <PageHeader
                title="Tickets"
                intro="Was im Postfach ankommt, als Vorgang. Die Nummer im Betreff hält eine Unterhaltung zusammen; ein Absender, der zu keinem Kontakt passt, wird gekennzeichnet statt stillschweigend einem Konto zugeschlagen."
                action={<SweepButton />}
            />

            <div className="space-y-6 px-6 py-10 md:px-10 md:py-12">
                <dl className="grid gap-4 sm:grid-cols-4">
                    {[
                        { label: "Offen", value: counts.open },
                        { label: "Wartet auf Kunden", value: counts.waiting },
                        { label: "Ohne Zuständige", value: counts.unassigned },
                        {
                            label: "Unbekannter Absender",
                            value: counts.unknownSender,
                        },
                    ].map((entry) => (
                        <div
                            key={entry.label}
                            className="rounded-lg border p-4"
                        >
                            <dt className="text-xs text-muted-foreground">
                                {entry.label}
                            </dt>
                            <dd className="mt-1 text-2xl font-semibold tabular-nums">
                                {entry.value}
                            </dd>
                        </div>
                    ))}
                </dl>

                <nav className="flex flex-wrap gap-2 text-xs">
                    {FILTERS.map((entry) => (
                        <Link
                            key={entry.href}
                            href={entry.href}
                            className="rounded-md border px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {entry.label}
                        </Link>
                    ))}
                    {departments.map((entry) => (
                        <Link
                            key={entry.id}
                            href={`/admin/tickets?department=${entry.id}`}
                            className="rounded-md border px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {entry.name}
                        </Link>
                    ))}
                </nav>

                {page.rows.length === 0 ? (
                    <p className="rounded-lg border p-6 text-sm text-muted-foreground">
                        Hier ist nichts. Entweder ist alles beantwortet, oder es
                        ist noch kein Postfach angebunden — das geht unter
                        Einstellungen → Postfach.
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {page.rows.map((row) => (
                            <li key={row.id}>
                                <Link
                                    href={`/admin/tickets/${row.id}`}
                                    className="flex flex-col gap-2 px-4 py-4 transition-colors hover:bg-muted/40 md:flex-row md:items-center md:justify-between"
                                >
                                    <div className="min-w-0 space-y-1">
                                        <p className="flex items-center gap-2 text-sm">
                                            <code className="text-xs text-muted-foreground">
                                                {formatTicketNumber(row.number)}
                                            </code>
                                            <span className="truncate font-medium">
                                                {row.subject}
                                            </span>
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {row.customerName ??
                                                row.requesterEmail}{" "}
                                            · {row.departmentName} ·{" "}
                                            {row.messageCount} Nachrichten ·{" "}
                                            {formatDateTime(row.lastMessageAt)}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                                        {row.unknownSender ? (
                                            <StatusBadge
                                                label="Unbekannter Absender"
                                                tone="warning"
                                            />
                                        ) : null}
                                        <StatusBadge
                                            label={
                                                TICKET_PRIORITY_LABEL[
                                                    row.priority
                                                ]
                                            }
                                            tone={
                                                TICKET_PRIORITY_TONE[
                                                    row.priority
                                                ]
                                            }
                                        />
                                        <StatusBadge
                                            label={
                                                TICKET_STATUS_LABEL[row.status]
                                            }
                                            tone={
                                                TICKET_STATUS_TONE[row.status]
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {row.assigneeName ??
                                                "nicht zugewiesen"}
                                        </span>
                                    </div>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
