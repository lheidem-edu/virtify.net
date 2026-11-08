import { asc } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db, schema } from "@/db";
import {
    formatBytes,
    formatDateTime,
    TICKET_PRIORITY_LABEL,
    TICKET_STATUS_LABEL,
    TICKET_STATUS_TONE,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listDepartments } from "@/server/tickets/departments";
import { formatTicketNumber } from "@/server/tickets/numbering";
import {
    ANY_CUSTOMER,
    listCannedReplies,
    listTickets,
    loadTicket,
} from "@/server/tickets/repository";
import MessageBody from "./message-body";
import TicketForms from "./ticket-forms";

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requirePermission("tickets.read");

    const { id } = await params;
    const loaded = await loadTicket(id, ANY_CUSTOMER, db, {
        includeNotes: true,
    });

    if (!loaded) {
        notFound();
    }

    const [departments, staff, canned, open] = await Promise.all([
        listDepartments(db),
        db
            .select({ id: schema.staffUser.id, name: schema.staffUser.name })
            .from(schema.staffUser)
            .orderBy(asc(schema.staffUser.name)),
        listCannedReplies(db),
        listTickets(ANY_CUSTOMER, { status: "open-ish", limit: 50 }, db),
    ]);

    const ticket = loaded.ticket;

    return (
        <>
            <PageHeader
                title={`${formatTicketNumber(ticket.number)} · ${ticket.subject}`}
                intro={`Von ${ticket.requesterName ?? ticket.requesterEmail} <${ticket.requesterEmail}> · ${loaded.departmentName}`}
                action={
                    <div className="flex flex-wrap items-center gap-2">
                        {ticket.unknownSender ? (
                            <StatusBadge
                                label="Unbekannter Absender"
                                tone="warning"
                            />
                        ) : null}
                        <StatusBadge
                            label={TICKET_PRIORITY_LABEL[ticket.priority]}
                        />
                        <StatusBadge
                            label={TICKET_STATUS_LABEL[ticket.status]}
                            tone={TICKET_STATUS_TONE[ticket.status]}
                        />
                    </div>
                }
            />

            <div className="grid gap-10 px-6 py-10 md:grid-cols-[minmax(0,1fr)_320px] md:px-10 md:py-12">
                <div className="space-y-6">
                    {ticket.mergedIntoTicketId ? (
                        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                            Dieses Ticket wurde zusammengeführt. Die
                            Unterhaltung steht in{" "}
                            <Link
                                href={`/admin/tickets/${ticket.mergedIntoTicketId}`}
                                className="underline"
                            >
                                dem Ziel-Ticket
                            </Link>
                            . Die Nummer bleibt gültig: eine Antwort mit{" "}
                            <code>{formatTicketNumber(ticket.number)}</code> im
                            Betreff landet dort.
                        </p>
                    ) : null}

                    {loaded.mergedIn.length > 0 ? (
                        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                            Hierher zusammengeführt:{" "}
                            {loaded.mergedIn
                                .map((row) => formatTicketNumber(row.number))
                                .join(", ")}
                        </p>
                    ) : null}

                    <ol className="space-y-4">
                        {loaded.messages.map((message) => (
                            <li
                                key={message.id}
                                className={`rounded-lg border p-4 ${
                                    message.direction === "note"
                                        ? "border-amber-500/40 bg-amber-500/5"
                                        : message.direction === "outbound"
                                          ? "bg-muted/30"
                                          : ""
                                }`}
                            >
                                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    <span className="font-medium text-foreground">
                                        {message.authorName ??
                                            message.authorEmail ??
                                            "System"}
                                    </span>
                                    <span>
                                        {message.direction === "note"
                                            ? "interne Notiz"
                                            : message.direction === "outbound"
                                              ? "gesendet"
                                              : "empfangen"}
                                    </span>
                                    <span>
                                        {formatDateTime(message.sentAt)}
                                    </span>
                                    {message.isAutomated ? (
                                        <StatusBadge
                                            label="automatisch"
                                            tone="muted"
                                        />
                                    ) : null}
                                </p>

                                <MessageBody
                                    displayText={message.displayText}
                                    displayHtml={message.displayHtml}
                                    originalHtml={message.originalHtml}
                                    originalText={message.originalText}
                                />

                                {message.attachments.length > 0 ? (
                                    <ul className="mt-3 flex flex-wrap gap-2 text-xs">
                                        {message.attachments.map(
                                            (attachment) => (
                                                <li key={attachment.id}>
                                                    <a
                                                        href={`/client/tickets/attachments/${attachment.id}`}
                                                        className="rounded-md border px-2 py-1 text-muted-foreground hover:text-foreground"
                                                    >
                                                        {attachment.filename} (
                                                        {formatBytes(
                                                            attachment.sizeBytes,
                                                        )}
                                                        )
                                                    </a>
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                ) : null}
                            </li>
                        ))}
                    </ol>
                </div>

                <TicketForms
                    ticketId={ticket.id}
                    status={ticket.status}
                    priority={ticket.priority}
                    assigneeId={ticket.assigneeId}
                    customerId={ticket.customerId}
                    customerName={loaded.customerName}
                    merged={Boolean(ticket.mergedIntoTicketId)}
                    staff={staff}
                    departments={departments.map((entry) => ({
                        id: entry.id,
                        name: entry.name,
                    }))}
                    cannedReplies={canned.map((entry) => ({
                        id: entry.id,
                        title: entry.title,
                        body: entry.body,
                    }))}
                    mergeTargets={open.rows
                        .filter((row) => row.id !== ticket.id)
                        .map((row) => ({
                            id: row.id,
                            label: `${formatTicketNumber(row.number)} · ${row.subject}`,
                        }))}
                />
            </div>
        </>
    );
}
