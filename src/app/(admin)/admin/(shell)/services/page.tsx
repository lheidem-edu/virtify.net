import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import type { ServiceStatus } from "@/db/schema";
import {
    formatDateTime,
    SERVICE_STATUS_LABEL,
    SERVICE_STATUS_TONE,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import {
    ANY_CUSTOMER,
    listServices,
    queueSummary,
    recentTasks,
} from "@/server/provisioning/repository";
import { RunPassButton } from "./service-forms";

const FILTERS: { href: string; label: string }[] = [
    { href: "/admin/services", label: "Alle" },
    { href: "/admin/services?status=pending", label: "Wartet" },
    { href: "/admin/services?status=provisioning", label: "In Einrichtung" },
    { href: "/admin/services?status=active", label: "Aktiv" },
    { href: "/admin/services?status=suspended", label: "Gesperrt" },
    { href: "/admin/services?status=terminated", label: "Beendet" },
];

const STATUSES: ServiceStatus[] = [
    "pending",
    "provisioning",
    "active",
    "suspended",
    "terminated",
];

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{ status?: string }>;
}) {
    await requirePermission("services.read");

    const { status } = await searchParams;
    const filter = STATUSES.find((entry) => entry === status);

    const rows = await listServices(db, ANY_CUSTOMER, {
        status: filter ? [filter] : undefined,
        limit: 200,
        includeTerminated: filter === "terminated",
    });
    const queue = await queueSummary(db);
    const tasks = await recentTasks(db, 20);

    return (
        <>
            <PageHeader
                title="Leistungen"
                intro="Was tatsächlich läuft, und was die Module zuletzt damit gemacht haben."
            />

            <div className="space-y-10 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-4">
                    <div className="flex flex-wrap items-center gap-4 text-sm">
                        <span>
                            Warteschlange:{" "}
                            <span className="font-mono">{queue.pending}</span>{" "}
                            offen,{" "}
                            <span className="font-mono">{queue.running}</span>{" "}
                            laufend,{" "}
                            <span className="font-mono">{queue.failed}</span>{" "}
                            fehlgeschlagen,{" "}
                            <span className="font-mono">{queue.aborted}</span>{" "}
                            abgebrochen
                        </span>
                    </div>
                    <RunPassButton />
                </section>

                <nav className="flex flex-wrap gap-2 text-sm">
                    {FILTERS.map((entry) => (
                        <Link
                            key={entry.href}
                            href={entry.href}
                            className="rounded-full border px-3 py-1 transition-colors hover:border-ring"
                        >
                            {entry.label}
                        </Link>
                    ))}
                </nav>

                <section className="space-y-3">
                    {rows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Keine Leistungen in dieser Auswahl.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {rows.map((row) => (
                                <li key={row.id}>
                                    <Link
                                        href={`/admin/services/${row.id}`}
                                        className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-4 py-3 transition-colors hover:border-ring"
                                    >
                                        <span>
                                            <span className="text-sm">
                                                {row.label}
                                            </span>
                                            <span className="block text-xs text-muted-foreground">
                                                {row.moduleLabel}
                                                {row.primaryAddress
                                                    ? ` · ${row.primaryAddress}`
                                                    : ""}
                                                {row.hostname
                                                    ? ` · ${row.hostname}`
                                                    : ""}
                                            </span>
                                        </span>
                                        <span className="flex items-center gap-4">
                                            {row.providerStatus ? (
                                                <span className="text-xs text-muted-foreground">
                                                    Maschine:{" "}
                                                    {row.providerStatus}
                                                </span>
                                            ) : null}
                                            <StatusBadge
                                                label={
                                                    SERVICE_STATUS_LABEL[
                                                        row.status
                                                    ]
                                                }
                                                tone={
                                                    SERVICE_STATUS_TONE[
                                                        row.status
                                                    ]
                                                }
                                            />
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className="space-y-3">
                    <h2 className="text-sm font-medium">Letzte Aufrufe</h2>
                    {tasks.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Es wurde noch nichts bereitgestellt.
                        </p>
                    ) : (
                        <ul className="space-y-1 text-sm">
                            {tasks.map((entry) => (
                                <li
                                    key={entry.task.id}
                                    className="flex flex-wrap items-baseline justify-between gap-3 rounded-lg border px-4 py-2"
                                >
                                    <span>
                                        <Link
                                            href={`/admin/services/${entry.task.serviceId}`}
                                            className="underline underline-offset-4"
                                        >
                                            {entry.serviceLabel}
                                        </Link>{" "}
                                        <span className="font-mono text-xs">
                                            {entry.task.action}
                                        </span>
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {entry.task.status}
                                        {" · "}
                                        {entry.task.attempts}/
                                        {entry.task.maxAttempts}
                                        {" · "}
                                        {formatDateTime(entry.task.createdAt)}
                                        {entry.task.lastError
                                            ? ` · ${entry.task.lastError.slice(0, 120)}`
                                            : ""}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </>
    );
}
