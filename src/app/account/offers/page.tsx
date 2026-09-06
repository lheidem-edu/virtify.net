import Link from "next/link";
import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { listOffers } from "@/lib/documents/repository";
import {
    formatDate,
    formatPrice,
    OFFER_STATUS_LABEL,
    OFFER_STATUS_TONE,
} from "@/lib/format";
import DecideForm from "./decide-form";

export default async function Page() {
    const session = await requireSession();
    const offers = (await listOffers(session.user.id, false)).filter(
        (entry) => entry.status !== "draft",
    );

    return (
        <>
            <PageHeader
                title="Angebote"
                intro="Angebote, die wir dir gemacht haben. Mit der Annahme kommt der Vertrag zustande."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                {offers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Es liegen derzeit keine Angebote vor.
                    </p>
                ) : (
                    <ul className="max-w-3xl border-t">
                        {offers.map((entry) => (
                            <li key={entry.id} className="border-b py-6">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                                    <h2 className="text-sm font-medium tracking-tight">
                                        {entry.title}
                                    </h2>
                                    <StatusBadge
                                        label={OFFER_STATUS_LABEL[entry.status]}
                                        tone={OFFER_STATUS_TONE[entry.status]}
                                    />
                                </div>
                                <p className="mt-1 font-mono text-xs text-zinc-600">
                                    {entry.number}
                                </p>

                                <dl className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
                                    <div className="flex gap-4">
                                        <dt className="w-44 shrink-0 text-sm text-muted-foreground">
                                            Monatlich
                                        </dt>
                                        <dd className="font-mono text-sm">
                                            {formatPrice(
                                                entry.monthlyPriceCents,
                                            )}
                                        </dd>
                                    </div>
                                    <div className="flex gap-4">
                                        <dt className="w-44 shrink-0 text-sm text-muted-foreground">
                                            Gültig bis
                                        </dt>
                                        <dd className="font-mono text-sm">
                                            {formatDate(entry.validUntil)}
                                        </dd>
                                    </div>
                                </dl>

                                <div className="mt-5 flex flex-wrap items-center gap-6">
                                    <Link
                                        href={`/account/offers/${entry.id}/pdf`}
                                        className="text-sm underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white"
                                    >
                                        Angebot als PDF
                                    </Link>
                                    {entry.status === "sent" ? (
                                        <DecideForm offerId={entry.id} />
                                    ) : null}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}
