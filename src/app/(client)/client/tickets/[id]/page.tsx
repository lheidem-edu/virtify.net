import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import {
    formatBytes,
    formatDateTime,
    TICKET_STATUS_LABEL,
    TICKET_STATUS_TONE,
} from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { formatTicketNumber } from "@/server/tickets/numbering";
import { loadTicket } from "@/server/tickets/repository";
import ReplyForm from "./reply-form";

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { customer, contact } = await getCurrentCustomer();
    const { id } = await params;

    /**
     * Scoped to this account, and `includeNotes` is left off — an internal
     * note is filtered out by the query rather than by this page, so it
     * cannot be shown by a component that forgot.
     */
    const loaded = await loadTicket(id, customer.id, db);

    if (!loaded) {
        notFound();
    }

    const ticket = loaded.ticket;

    return (
        <>
            <PageHeader
                title={ticket.subject}
                intro={`${formatTicketNumber(ticket.number)} · ${loaded.departmentName} · eröffnet ${formatDateTime(ticket.createdAt)}`}
                action={
                    <StatusBadge
                        label={TICKET_STATUS_LABEL[ticket.status]}
                        tone={TICKET_STATUS_TONE[ticket.status]}
                    />
                }
            />

            <div className="space-y-8 px-6 py-10 md:px-10 md:py-12">
                <ol className="space-y-4">
                    {loaded.messages.map((message) => (
                        <li
                            key={message.id}
                            className={`rounded-lg border p-4 ${
                                message.direction === "outbound"
                                    ? "bg-muted/30"
                                    : ""
                            }`}
                        >
                            <p className="text-xs text-muted-foreground">
                                {message.direction === "outbound"
                                    ? "Support"
                                    : (message.authorName ??
                                      message.authorEmail ??
                                      "Du")}{" "}
                                · {formatDateTime(message.sentAt)}
                            </p>
                            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-6">
                                {message.displayText}
                            </pre>
                            {message.attachments.length > 0 ? (
                                <ul className="mt-3 flex flex-wrap gap-2 text-xs">
                                    {message.attachments.map((attachment) => (
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
                                    ))}
                                </ul>
                            ) : null}
                        </li>
                    ))}
                </ol>

                {contact.canTickets ? (
                    <ReplyForm
                        ticketId={ticket.id}
                        closed={ticket.status === "closed"}
                    />
                ) : (
                    <p className="text-sm text-muted-foreground">
                        Dieser Zugang darf nicht auf Tickets antworten.
                    </p>
                )}
            </div>
        </>
    );
}
