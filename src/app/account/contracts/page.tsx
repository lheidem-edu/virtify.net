import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { listContracts } from "@/lib/documents/repository";
import {
    CONTRACT_STATUS_LABEL,
    CONTRACT_STATUS_TONE,
    formatDate,
    formatPrice,
} from "@/lib/format";

export default async function Page() {
    const session = await requireSession();
    const contracts = await listContracts(session.user.id, false);

    return (
        <>
            <PageHeader
                title="Verträge"
                intro="Deine laufenden und beendeten Verträge."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                {contracts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Für dein Konto ist derzeit kein Vertrag hinterlegt.
                    </p>
                ) : (
                    <ul className="max-w-3xl border-t">
                        {contracts.map((contract) => (
                            <li key={contract.id} className="border-b py-6">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                                    <h2 className="text-sm font-medium tracking-tight">
                                        {contract.title}
                                    </h2>
                                    <StatusBadge
                                        label={
                                            CONTRACT_STATUS_LABEL[
                                                contract.status
                                            ]
                                        }
                                        tone={
                                            CONTRACT_STATUS_TONE[
                                                contract.status
                                            ]
                                        }
                                    />
                                </div>
                                <p className="mt-1 font-mono text-xs break-all text-zinc-600">
                                    {contract.number}
                                </p>
                                <dl className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
                                    {[
                                        [
                                            "Monatliche Vergütung",
                                            formatPrice(
                                                contract.monthlyPriceCents,
                                            ),
                                        ],
                                        [
                                            "Service-Readiness",
                                            formatDate(contract.serviceReadyAt),
                                        ],
                                        [
                                            "Grundlaufzeit",
                                            `${contract.minimumTermMonths} Monate`,
                                        ],
                                        ...(contract.terminatedTo
                                            ? [
                                                  [
                                                      "Gekündigt zum",
                                                      formatDate(
                                                          contract.terminatedTo,
                                                      ),
                                                  ],
                                              ]
                                            : []),
                                    ].map(([label, value]) => (
                                        <div key={label} className="flex gap-4">
                                            <dt className="w-44 shrink-0 text-sm text-muted-foreground">
                                                {label}
                                            </dt>
                                            <dd className="font-mono text-sm">
                                                {value}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
