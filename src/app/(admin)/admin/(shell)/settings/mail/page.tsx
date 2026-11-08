import { desc, isNull } from "drizzle-orm";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db, schema } from "@/db";
import { formatDateTime } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listDepartments } from "@/server/tickets/departments";
import { inboundStats } from "@/server/tickets/inbound";
import { notificationUrl } from "@/server/tickets/run";
import { loadMailChannelConfig } from "@/server/tickets/settings";
import ChannelForm from "./channel-form";
import DepartmentForm from "./department-form";
import SyncButton from "./sync-button";

export const dynamic = "force-dynamic";

/**
 * The mailbox, the queues behind it and the state of the connection.
 *
 * The credentials are encrypted at rest (hard rule 6) and write-only: this
 * page can say that something is stored, never what. There are no tenant
 * credentials for this installation, so everything below is expected to
 * read "nicht eingerichtet" until an operator fills it in — see
 * `docs/m365-setup.md` for what has to happen in Entra and Exchange first.
 */
export default async function Page() {
    await requirePermission("tickets.manage");

    const [config, departments, subscriptions, stats] = await Promise.all([
        loadMailChannelConfig(),
        listDepartments(db),
        db
            .select()
            .from(schema.mailSubscription)
            .where(isNull(schema.mailSubscription.removedAt))
            .orderBy(desc(schema.mailSubscription.expiresAt)),
        inboundStats(db),
    ]);

    const url = notificationUrl();

    return (
        <>
            <PageHeader
                title="Postfach"
                intro="Die Anbindung an Microsoft 365: wovon Tickets kommen, wohin Antworten gehen und ob die Benachrichtigungen noch laufen. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt."
                action={<SyncButton />}
            />

            <section className="space-y-6 border-b px-6 py-10 md:px-10 md:py-12">
                <div className="flex items-center gap-3">
                    <h2 className="text-sm font-medium tracking-tight">
                        Microsoft 365 (Graph)
                    </h2>
                    <StatusBadge
                        label={config.enabled ? "Aktiv" : "Nicht eingerichtet"}
                        tone={config.enabled ? "positive" : "muted"}
                    />
                    <StatusBadge
                        label={
                            config.transport === "graph"
                                ? "Systemmails über Graph"
                                : "Systemmails über SMTP"
                        }
                    />
                </div>

                <p className="max-w-2xl text-sm text-muted-foreground">
                    Graph meldet neue Nachrichten an{" "}
                    <code>{url ?? "— keine https-Adresse konfiguriert —"}</code>
                    . Die Benachrichtigung selbst wird nichts geglaubt: sie
                    benennt eine Nachricht in einem Postfach, das wir ohnehin
                    kennen, und der Auftrag holt die Nachricht danach bei Graph
                    ab. Alle fünf Minuten läuft zusätzlich eine Delta-Abfrage,
                    damit eine verlorene Benachrichtigung nur Verzögerung
                    kostet.
                </p>

                <ChannelForm
                    enabled={config.enabled}
                    source={config.source}
                    hasTenant={config.credentials.tenantId !== ""}
                    hasClientId={config.credentials.clientId !== ""}
                    hasSecret={config.credentials.clientSecret !== ""}
                    processedFolder={config.processedFolder}
                    maxAttachmentMb={Math.round(
                        config.maxAttachmentBytes / (1024 * 1024),
                    )}
                    autoReplyPerHour={config.autoReplyPerHour}
                    outboundSender={config.outboundSender}
                    transport={config.transport}
                />
            </section>

            <section className="space-y-4 border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="text-sm font-medium tracking-tight">
                    Benachrichtigungen
                </h2>

                {subscriptions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Zurzeit keine. Sie werden stündlich angelegt und
                        erneuert, sobald der Kanal eingerichtet ist — Graph
                        vergibt sie für höchstens drei Tage und stellt danach
                        wortlos ein.
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border text-sm">
                        {subscriptions.map((row) => (
                            <li
                                key={row.id}
                                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                            >
                                <span>{row.mailbox}</span>
                                <span className="text-xs text-muted-foreground">
                                    läuft ab {formatDateTime(row.expiresAt)} ·
                                    zuletzt erneuert{" "}
                                    {formatDateTime(row.lastRenewedAt)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}

                <p className="text-xs text-muted-foreground">
                    Eingehend verarbeitet: {stats.filed} zu Tickets,{" "}
                    {stats.ignored} verworfen (eigene Nachrichten,
                    Abwesenheitsnotizen, Unzustellbarkeiten), {stats.pending}{" "}
                    noch offen.
                </p>
            </section>

            <section className="space-y-6 px-6 py-10 md:px-10 md:py-12">
                <h2 className="text-sm font-medium tracking-tight">
                    Abteilungen
                </h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                    Je Abteilung genau ein Postfach, und je Postfach genau eine
                    Abteilung. Zwei Abteilungen auf einem Postfach würden die
                    Frage „in welche Warteschlange gehört diese Nachricht“ zu
                    einem Münzwurf machen.
                </p>

                <ul className="space-y-4">
                    {departments.map((row) => (
                        <li key={row.id}>
                            <DepartmentForm
                                id={row.id}
                                name={row.name}
                                slug={row.slug}
                                mailbox={row.mailbox}
                                description={row.description}
                                isDefault={row.isDefault}
                                active={row.active}
                            />
                        </li>
                    ))}
                </ul>

                <DepartmentForm />
            </section>
        </>
    );
}
