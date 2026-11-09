import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import {
    formatDateTime,
    SERVICE_STATUS_LABEL,
    SERVICE_STATUS_TONE,
} from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { ANY_CUSTOMER, loadService } from "@/server/provisioning/repository";
import {
    AdminCredentialReveal,
    LifecycleActions,
    RdnsForm,
    RetryTaskButton,
} from "../service-forms";

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requirePermission("services.read");

    const { id } = await params;
    const loaded = await loadService(db, id, ANY_CUSTOMER);

    if (!loaded) {
        notFound();
    }

    const { service, addresses, tasks, mismatch } = loaded;
    const moduleData = (service.moduleData as Record<string, unknown>) ?? {};

    return (
        <>
            <PageHeader
                title={service.label}
                intro={`${loaded.moduleLabel}${
                    loaded.serverName ? ` auf ${loaded.serverName}` : ""
                }${loaded.externalId ? ` · ${loaded.externalId}` : ""}`}
            />

            <div className="space-y-10 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <StatusBadge
                            label={SERVICE_STATUS_LABEL[service.status]}
                            tone={SERVICE_STATUS_TONE[service.status]}
                        />
                        <Link
                            href={`/admin/customers/${service.customerId}`}
                            className="text-xs underline underline-offset-4"
                        >
                            Kunde
                        </Link>
                        {loaded.subscriptionId ? (
                            <Link
                                href={`/admin/subscriptions/${loaded.subscriptionId}`}
                                className="text-xs underline underline-offset-4"
                            >
                                Abo ({loaded.subscriptionStatus})
                            </Link>
                        ) : null}
                        {service.providerStatus ? (
                            <span className="text-xs text-muted-foreground">
                                Maschine: {service.providerStatus}
                                {service.providerStatusAt
                                    ? ` (${formatDateTime(service.providerStatusAt)})`
                                    : ""}
                                {service.providerStatusDetail
                                    ? ` — ${service.providerStatusDetail}`
                                    : ""}
                            </span>
                        ) : null}
                    </div>

                    {/*
                     * The disagreement. Shown, and acted on by nothing — see
                     * `src/server/provisioning/runner.ts`. If the reading
                     * were written into `status`, a VM somebody stopped by
                     * hand in the Proxmox UI would be woken by the mirror in
                     * `wakeSettledIn` and stopped again by the next sync.
                     */}
                    {mismatch ? (
                        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
                            {mismatch} Der Stand der Leistung gilt — hier wird
                            nichts automatisch angeglichen.
                        </p>
                    ) : null}
                </section>

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Lebenszyklus</h2>
                    <LifecycleActions
                        serviceId={service.id}
                        status={service.status}
                    />
                </section>

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Adressen</h2>
                    {addresses.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Keine Adresse zugewiesen.
                        </p>
                    ) : (
                        <div className="space-y-3">
                            {addresses.map((address) => (
                                <RdnsForm
                                    key={address.id}
                                    addressId={address.id}
                                    serviceId={service.id}
                                    address={`${address.address}/${address.prefixLength}`}
                                    rdns={address.rdns}
                                />
                            ))}
                        </div>
                    )}
                </section>

                {service.credentialsEncrypted ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Zugangsdaten</h2>
                        <AdminCredentialReveal serviceId={service.id} />
                    </section>
                ) : null}

                {Object.keys(moduleData).length > 0 ? (
                    <section className="space-y-3">
                        <h2 className="text-sm font-medium">Moduldaten</h2>
                        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
                            {Object.entries(moduleData).map(([key, value]) => (
                                <div key={key} className="contents">
                                    <dt className="text-muted-foreground">
                                        {key}
                                    </dt>
                                    <dd className="font-mono break-all">
                                        {String(value)}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </section>
                ) : null}

                <section className="space-y-3">
                    <h2 className="text-sm font-medium">Aufrufe</h2>
                    {tasks.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Noch nichts verlangt.
                        </p>
                    ) : (
                        <ul className="space-y-2 text-sm">
                            {tasks.map((task) => (
                                <li
                                    key={task.id}
                                    className="space-y-1 rounded-lg border px-4 py-3"
                                >
                                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                                        <span className="font-mono text-xs">
                                            {task.action} · {task.requestKey}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {task.status} · {task.attempts}/
                                            {task.maxAttempts} ·{" "}
                                            {formatDateTime(task.createdAt)}
                                        </span>
                                    </div>
                                    {task.lastError ? (
                                        <p className="text-xs text-destructive">
                                            {task.lastError}
                                        </p>
                                    ) : null}
                                    {task.providerCalledAt === null &&
                                    task.status === "aborted" ? (
                                        <p className="text-xs text-muted-foreground">
                                            Abgebrochen, bevor etwas verlangt
                                            wurde — auf dem Server ist nichts
                                            entstanden, Adressen und Kennung
                                            wurden zurückgegeben.
                                        </p>
                                    ) : null}
                                    {task.status === "failed" ||
                                    task.status === "aborted" ? (
                                        <RetryTaskButton
                                            taskId={task.id}
                                            serviceId={service.id}
                                        />
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </>
    );
}
