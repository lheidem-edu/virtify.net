import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import {
    formatDate,
    SERVICE_STATUS_LABEL,
    SERVICE_STATUS_TONE,
} from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { listServices } from "@/server/provisioning/repository";

export default async function Page() {
    const { customer } = await getCurrentCustomer();
    const rows = await listServices(db, customer.id, { limit: 100 });

    return (
        <>
            <PageHeader
                title="Leistungen"
                intro="Was tatsächlich läuft: deine Server, ihre Adressen und was du daran selbst steuern kannst."
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Du hast noch keine Leistung.
                    </p>
                ) : (
                    <ul className="space-y-3">
                        {rows.map((row) => (
                            <li key={row.id}>
                                <Link
                                    href={`/client/services/${row.id}`}
                                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-6 py-4 transition-colors hover:border-ring"
                                >
                                    <span>
                                        <span className="text-sm">
                                            {row.label}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                            {row.primaryAddress ??
                                                (row.status === "pending"
                                                    ? "wird eingerichtet"
                                                    : "keine Adresse")}
                                            {row.activatedAt
                                                ? ` · seit ${formatDate(row.activatedAt)}`
                                                : ""}
                                        </span>
                                    </span>
                                    <span className="flex items-center gap-4">
                                        <span className="text-xs text-muted-foreground">
                                            {row.moduleLabel}
                                        </span>
                                        <StatusBadge
                                            label={
                                                SERVICE_STATUS_LABEL[row.status]
                                            }
                                            tone={
                                                SERVICE_STATUS_TONE[row.status]
                                            }
                                        />
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
