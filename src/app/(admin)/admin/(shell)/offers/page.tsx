import PageHeader from "@/components/shared/page-header";
import type { OFFER_STATUS_LABEL } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import {
    ANY_CUSTOMER,
    listCustomerAccounts,
    listOffers,
} from "@/server/documents/repository";
import AdminOffersTable from "./admin-offers-table";
import OfferForm from "./offer-form";

export default async function Page() {
    await requirePermission("offers.read");

    const accounts = await listCustomerAccounts();

    const offers = await listOffers(ANY_CUSTOMER, true);

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
