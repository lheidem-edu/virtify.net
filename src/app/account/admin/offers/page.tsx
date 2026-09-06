import { asc } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { db, schema } from "@/lib/db";
import { listOffers } from "@/lib/documents/repository";
import type { OFFER_STATUS_LABEL } from "@/lib/format";
import AdminOffersTable from "./admin-offers-table";
import OfferForm from "./offer-form";

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
                <AdminOffersTable
                    rows={offers.map((entry) => ({
                        id: entry.id,
                        number: entry.number,
                        title: entry.title,
                        status: entry.status as keyof typeof OFFER_STATUS_LABEL,
                        validUntil: entry.validUntil,
                        monthlyPriceCents: entry.monthlyPriceCents,
                        amount: entry.amount,
                        email: entry.email,
                    }))}
                />
            </div>
        </>
    );
}
