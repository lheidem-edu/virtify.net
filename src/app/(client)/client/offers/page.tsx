import PageHeader from "@/components/shared/page-header";
import type { OFFER_STATUS_LABEL } from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { listOffers } from "@/server/documents/repository";
import OffersTable from "./offers-table";

export default async function Page() {
    const { customer } = await getCurrentCustomer();

    const offers = (await listOffers(customer.id, false))
        .filter((entry) => entry.status !== "draft")
        .map((entry) => ({
            id: entry.id,
            number: entry.number,
            title: entry.title,
            status: entry.status as keyof typeof OFFER_STATUS_LABEL,
            validUntil: entry.validUntil,
            monthlyPriceCents: entry.monthlyPriceCents,
            amount: entry.amount,
        }));

    return (
        <>
            <PageHeader
                title="Angebote"
                intro="Angebote, die wir dir gemacht haben. Mit der Annahme kommt der Vertrag zustande."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <OffersTable rows={offers} />
            </div>
        </>
    );
}
