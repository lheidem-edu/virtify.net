import { asc } from "drizzle-orm";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { db, schema } from "@/lib/db";
import { listOffers } from "@/lib/documents/repository";
import {
    formatDate,
    formatPrice,
    OFFER_STATUS_LABEL,
    OFFER_STATUS_TONE,
} from "@/lib/format";
import OfferForm from "./offer-form";
import SendForm from "./send-form";

export default async function Page() {
    const session = await requireAdmin();

    const accounts = await db
        .select({
            id: schema.user.id,
            name: schema.user.name,
            email: schema.user.email,
        })
        .from(schema.user)
        .orderBy(asc(schema.user.email));

    const offers = await listOffers(session.user.id, true);

    return (
        <>
            <PageHeader
                title="Angebote"
                intro="Angebote schreiben und versenden. Mit der Annahme durch den Kunden entsteht automatisch ein Vertrag."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Neues Angebot
                </h2>
                <OfferForm accounts={accounts} />
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Alle Angebote
                </h2>
                {offers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Noch keine Angebote.
                    </p>
                ) : (
                    <ul className="max-w-3xl border-t">
                        {offers.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b py-5"
                            >
                                <div>
                                    <p className="font-mono text-sm">
                                        {entry.number}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {entry.title} · {entry.email} ·{" "}
                                        {formatPrice(entry.monthlyPriceCents)}
                                        /Monat
                                        {entry.validUntil
                                            ? ` · gültig bis ${formatDate(entry.validUntil)}`
                                            : ""}
                                    </p>
                                </div>
                                <div className="flex items-center gap-4">
                                    <StatusBadge
                                        label={OFFER_STATUS_LABEL[entry.status]}
                                        tone={OFFER_STATUS_TONE[entry.status]}
                                    />
                                    <Link
                                        href={`/account/offers/${entry.id}/pdf`}
                                        className="text-sm underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white"
                                    >
                                        PDF
                                    </Link>
                                    {entry.status === "draft" ? (
                                        <SendForm offerId={entry.id} />
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
