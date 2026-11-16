import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import type { EmailStatus } from "@/db/schema";
import { formatDateTime } from "@/lib/format";
import {
    currentStaffCan,
    requirePermission,
} from "@/server/auth/staff-session";
import { EVENT_LABELS, isEventType } from "@/server/events/catalog";
import { isResendable } from "@/server/mail/outbox";
import {
    emailCounts,
    eventBacklog,
    listEmails,
} from "@/server/mail/repository";
import {
    isMailTemplateId,
    MAIL_TEMPLATE_LABELS,
} from "@/server/mail/templates";
import {
    DIRECT_MAIL_LABELS,
    isDirectMailId,
} from "@/server/mail/templates/direct";
import { ResendButton, RunNotificationsButton } from "./notification-actions";

/**
 * Every message this installation has sent, and every fact still waiting to
 * become one.
 *
 * Two halves, and the split answers two different questions. The **mail log**
 * says what went to whom; the **event backlog** says what has not been turned
 * into mail yet — because a notification that is missing from the log may be
 * an event that never dispatched, and without the second list the operator
 * would have nothing to look at.
 *
 * This installation has no SMTP relay and no Microsoft 365 tenant, so in
 * practice rows sit here as `pending` with "kein Transport konfiguriert"
 * against them. That is deliberate rather than broken: the row is the record
 * that the message was *owed*, and nothing burns an attempt while there is no
 * way out of the building (see `runMailOutbox`).
 */

const STATUS_LABEL: Record<EmailStatus, string> = {
    pending: "wartet",
    sending: "wird versendet",
    sent: "versendet",
    failed: "fehlgeschlagen",
    unknown: "ungeklärt",
    abandoned: "aufgegeben",
};

const STATUS_TONE: Record<
    EmailStatus,
    "neutral" | "positive" | "warning" | "muted"
> = {
    pending: "neutral",
    sending: "neutral",
    sent: "positive",
    failed: "warning",
    /**
     * A warning and not "muted": `unknown` is the one state that needs a
     * person. It means the message may or may not have reached the customer,
     * and nothing will try again by itself.
     */
    unknown: "warning",
    abandoned: "muted",
};

const STATUS_ORDER: EmailStatus[] = [
    "pending",
    "failed",
    "unknown",
    "sending",
    "sent",
    "abandoned",
];

function templateLabel(id: string): string {
    if (isMailTemplateId(id)) {
        return MAIL_TEMPLATE_LABELS[id];
    }

    if (isDirectMailId(id)) {
        return DIRECT_MAIL_LABELS[id];
    }

    return id;
}

/** Where the thing a message is about lives in the admin area. */
function entityHref(
    entityType: string | null,
    entityId: string | null,
): string | null {
    if (!entityId) {
        return null;
    }

    switch (entityType) {
        case "invoice":
            return `/admin/invoices/${entityId}`;
        case "credit_note":
            return `/admin/credit-notes/${entityId}`;
        case "order":
            return `/admin/orders/${entityId}`;
        case "subscription":
            return `/admin/subscriptions/${entityId}`;
        case "service":
            return `/admin/services/${entityId}`;
        case "ticket":
            return `/admin/tickets/${entityId}`;
        case "customer":
            return `/admin/customers/${entityId}`;
        default:
            return null;
    }
}

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; q?: string; cursor?: string }>;
}) {
    await requirePermission("notifications.read");

    const params = await searchParams;
    const status = STATUS_ORDER.find((entry) => entry === params.status);

    const [counts, page, backlog] = await Promise.all([
        emailCounts(db),
        listEmails(db, {
            filter: {
                ...(status ? { status: [status] } : {}),
                ...(params.q ? { search: params.q } : {}),
            },
            cursor: params.cursor ?? null,
        }),
        eventBacklog(db, 25),
    ]);

    const maySend = await currentStaffCan("notifications.send");

    const filterHref = (next?: EmailStatus) =>
        next
            ? `/admin/notifications?status=${next}${params.q ? `&q=${encodeURIComponent(params.q)}` : ""}`
            : `/admin/notifications${params.q ? `?q=${encodeURIComponent(params.q)}` : ""}`;

    return (
        <>
            <PageHeader
                title="Benachrichtigungen"
                intro="Jede automatische Nachricht liegt als Zeile in email_log, bevor sie verschickt wird — mit dem Vorgang, der sie ausgelöst hat, als Schlüssel. Zweimal ausgelöst heißt deshalb einmal versendet."
                action={maySend ? <RunNotificationsButton /> : undefined}
            />

            <div className="space-y-10 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Link
                            href={filterHref()}
                            className={`rounded-md border px-3 py-1 text-xs transition-colors hover:border-ring ${
                                status ? "text-muted-foreground" : ""
                            }`}
                        >
                            Alle
                        </Link>
                        {STATUS_ORDER.map((entry) => (
                            <Link
                                key={entry}
                                href={filterHref(entry)}
                                className={`rounded-md border px-3 py-1 text-xs transition-colors hover:border-ring ${
                                    status === entry
                                        ? ""
                                        : "text-muted-foreground"
                                }`}
                            >
                                {STATUS_LABEL[entry]} · {counts[entry]}
                            </Link>
                        ))}
                    </div>

                    <form
                        action="/admin/notifications"
                        className="flex max-w-sm gap-2"
                    >
                        {status ? (
                            <input type="hidden" name="status" value={status} />
                        ) : null}
                        <input
                            type="search"
                            name="q"
                            defaultValue={params.q ?? ""}
                            placeholder="Adresse oder Betreff"
                            className="h-8 w-full rounded-md border bg-transparent px-3 text-xs outline-none focus-visible:border-ring"
                        />
                        <button
                            type="submit"
                            className="h-8 shrink-0 rounded-md border px-3 text-xs transition-colors hover:border-ring"
                        >
                            Suchen
                        </button>
                    </form>
                </section>

                <section className="space-y-3">
                    {page.rows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Keine Nachrichten.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {page.rows.map((row) => {
                                const href = entityHref(
                                    row.entityType,
                                    row.entityId,
                                );

                                return (
                                    <li
                                        key={row.id}
                                        className="rounded-lg border px-6 py-4"
                                    >
                                        <div className="flex flex-wrap items-start justify-between gap-4">
                                            <div className="min-w-0 space-y-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-sm font-medium">
                                                        {templateLabel(
                                                            row.template,
                                                        )}
                                                    </span>
                                                    <StatusBadge
                                                        label={
                                                            STATUS_LABEL[
                                                                row.status
                                                            ]
                                                        }
                                                        tone={
                                                            STATUS_TONE[
                                                                row.status
                                                            ]
                                                        }
                                                    />
                                                    {row.locale !== "de" ? (
                                                        <StatusBadge
                                                            label={row.locale.toUpperCase()}
                                                            tone="muted"
                                                        />
                                                    ) : null}
                                                    {row.resendOfId ? (
                                                        <StatusBadge
                                                            label="erneut"
                                                            tone="muted"
                                                        />
                                                    ) : null}
                                                </div>
                                                <p className="truncate text-sm text-muted-foreground">
                                                    {row.subject ??
                                                        "— noch nicht gerendert —"}
                                                </p>
                                                <p className="font-mono text-xs text-muted-foreground">
                                                    {row.toEmail}
                                                    {row.customerName
                                                        ? ` · ${row.customerName} (${row.customerNumber})`
                                                        : ""}
                                                </p>
                                            </div>

                                            <div className="shrink-0 space-y-1 text-right">
                                                <p className="text-xs text-muted-foreground">
                                                    {row.sentAt
                                                        ? formatDateTime(
                                                              row.sentAt,
                                                          )
                                                        : formatDateTime(
                                                              row.createdAt,
                                                          )}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {row.attempts}/
                                                    {row.maxAttempts} Versuch(e)
                                                    {row.transport
                                                        ? ` · ${row.transport}`
                                                        : ""}
                                                </p>
                                                {href ? (
                                                    <Link
                                                        href={href}
                                                        className="text-xs underline decoration-border underline-offset-4 transition-colors hover:decoration-current"
                                                    >
                                                        Vorgang öffnen
                                                    </Link>
                                                ) : null}
                                                {maySend &&
                                                isResendable(row.template) ? (
                                                    <ResendButton
                                                        id={row.id}
                                                        resendCount={
                                                            row.resendCount
                                                        }
                                                    />
                                                ) : null}
                                            </div>
                                        </div>

                                        {row.lastError ? (
                                            <p className="mt-3 text-xs leading-5 text-amber-500">
                                                {row.lastError}
                                            </p>
                                        ) : null}

                                        {row.status === "unknown" ? (
                                            <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                                Diese Nachricht wurde versendet
                                                oder auch nicht — der Vorgang
                                                ist abgebrochen, bevor er sich
                                                eintragen konnte. Sie wird
                                                bewusst nicht automatisch
                                                wiederholt: der Kunde hat sie
                                                möglicherweise schon.
                                            </p>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {page.nextCursor ? (
                        <Link
                            href={`/admin/notifications?${new URLSearchParams({
                                ...(status ? { status } : {}),
                                ...(params.q ? { q: params.q } : {}),
                                cursor: page.nextCursor,
                            }).toString()}`}
                            className="inline-block rounded-md border px-3 py-1 text-xs transition-colors hover:border-ring"
                        >
                            Ältere
                        </Link>
                    ) : null}
                </section>

                <section className="space-y-3">
                    <h2 className="text-sm font-medium">Ereignisse</h2>
                    <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                        Ein Ereignis wird in derselben Transaktion geschrieben
                        wie die Tatsache, über die es berichtet. Was hier steht,
                        ist noch nicht in Nachrichten übersetzt — oder hat es
                        nach mehreren Anläufen aufgegeben.
                    </p>

                    {backlog.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Nichts offen.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {backlog.map((event) => (
                                <li
                                    key={event.id}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4"
                                >
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-sm">
                                                {isEventType(event.type)
                                                    ? EVENT_LABELS[event.type]
                                                    : event.type}
                                            </span>
                                            <StatusBadge
                                                label={
                                                    event.status === "abandoned"
                                                        ? "aufgegeben"
                                                        : "wartet"
                                                }
                                                tone={
                                                    event.status === "abandoned"
                                                        ? "warning"
                                                        : "neutral"
                                                }
                                            />
                                        </div>
                                        <p className="font-mono text-xs text-muted-foreground">
                                            {event.entityType} ·{" "}
                                            {event.customerName ?? "—"}
                                        </p>
                                        {event.lastError ? (
                                            <p className="mt-1 text-xs text-amber-500">
                                                {event.lastError}
                                            </p>
                                        ) : null}
                                    </div>
                                    <p className="shrink-0 text-xs text-muted-foreground">
                                        {formatDateTime(event.occurredAt)} ·{" "}
                                        {event.attempts}/{event.maxAttempts}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </>
    );
}
