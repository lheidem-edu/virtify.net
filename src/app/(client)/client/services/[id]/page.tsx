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
import { getCurrentCustomer } from "@/server/customers/current";
import { loadService } from "@/server/provisioning/repository";
import { ConsoleButton, CredentialReveal, PowerActions } from "./service-forms";

const PROVIDER_STATUS_LABEL: Record<string, string> = {
    running: "läuft",
    stopped: "aus",
    suspended: "gesperrt",
    unknown: "unbekannt",
    missing: "nicht gefunden",
};

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { customer } = await getCurrentCustomer();
    const { id } = await params;

    // Scoped in the query: an id that is not this account's comes back null
    // and the page is simply not there (rule 5 — 404, never 403).
    const loaded = await loadService(db, id, customer.id);

    if (!loaded) {
        notFound();
    }

    const { service, addresses, mismatch } = loaded;
    const actions = loaded.clientActions.map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        destructive: action.destructive ?? false,
    }));

    return (
        <>
            <PageHeader
                title={service.label}
                intro={`${loaded.moduleLabel}${
                    service.hostname ? ` · ${service.hostname}` : ""
                }`}
            />

            <div className="space-y-10 px-6 py-10 md:px-10 md:py-12">
                <section className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <StatusBadge
                            label={SERVICE_STATUS_LABEL[service.status]}
                            tone={SERVICE_STATUS_TONE[service.status]}
                        />
                        {service.providerStatus ? (
                            <span className="text-xs text-muted-foreground">
                                Maschine:{" "}
                                {PROVIDER_STATUS_LABEL[
                                    service.providerStatus
                                ] ?? service.providerStatus}
                                {service.providerStatusAt
                                    ? ` (${formatDateTime(service.providerStatusAt)})`
                                    : ""}
                            </span>
                        ) : null}
                        {loaded.subscriptionId ? (
                            <Link
                                href={`/client/subscriptions/${loaded.subscriptionId}`}
                                className="text-xs underline underline-offset-4"
                            >
                                zum Abo
                            </Link>
                        ) : null}
                    </div>

                    {/*
                     * The disagreement, said out loud and acted on by
                     * nobody. See `src/server/provisioning/runner.ts`: a
                     * reading from the virtualisation never overwrites the
                     * status, because then the panel and whoever stopped the
                     * machine by hand would take turns undoing each other.
                     */}
                    {mismatch ? (
                        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
                            {mismatch} Wir sehen uns das an — melde dich gern
                            über ein Ticket, wenn es eilt.
                        </p>
                    ) : null}

                    {service.status === "suspended" ? (
                        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                            Diese Leistung ist gesperrt. Sobald die offene
                            Rechnung ausgeglichen ist, läuft sie wieder — ohne
                            dass du etwas tun musst.
                        </p>
                    ) : null}
                </section>

                <section className="space-y-4">
                    <h2 className="text-sm font-medium">Adressen</h2>
                    {addresses.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Noch keine Adresse zugewiesen.
                        </p>
                    ) : (
                        <ul className="space-y-2 text-sm">
                            {addresses.map((address) => (
                                <li
                                    key={address.id}
                                    className="flex flex-wrap items-baseline justify-between gap-3 rounded-lg border px-4 py-3"
                                >
                                    <span className="font-mono">
                                        {address.address}/{address.prefixLength}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {address.gateway
                                            ? `Gateway ${address.gateway}`
                                            : "kein Gateway"}
                                        {address.rdns
                                            ? ` · PTR ${address.rdns}`
                                            : ""}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {service.credentialsEncrypted ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Zugang</h2>
                        <CredentialReveal serviceId={service.id} />
                    </section>
                ) : null}

                {actions.length > 0 ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Steuerung</h2>
                        <PowerActions
                            serviceId={service.id}
                            actions={actions}
                            disabled={service.status !== "active"}
                            disabledReason={
                                service.status === "suspended"
                                    ? "Solange die Leistung gesperrt ist, lässt sie sich nicht steuern."
                                    : service.status === "terminated"
                                      ? "Diese Leistung ist abgebaut."
                                      : "Diese Leistung wird noch eingerichtet."
                            }
                        />
                    </section>
                ) : null}

                {service.status === "active" ? (
                    <section className="space-y-4">
                        <h2 className="text-sm font-medium">Konsole</h2>
                        <ConsoleButton serviceId={service.id} />
                    </section>
                ) : null}
            </div>
        </>
    );
}
