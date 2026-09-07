import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { earliestTerminationDate } from "@/lib/documents/contract-term";
import { dateInputValue } from "@/lib/documents/line-items";
import {
    listContracts,
    listCustomerAccounts,
} from "@/lib/documents/repository";
import type { CONTRACT_STATUS_LABEL } from "@/lib/format";
import AdminContractsTable from "./admin-contracts-table";
import ContractForm from "./contract-form";

export default async function Page() {
    const session = await requireAdmin();

    const accounts = await listCustomerAccounts();

    const contracts = await listContracts(session.user.id, true);
    // Die Kündigungsfrist rechnet gegen den Tag des Zugangs — für den Vorschlag
    // im Dialog ist das der Tag, an dem die Liste gerendert wird.
    const today = new Date();

    return (
        <>
            <PageHeader
                title="Verträge"
                intro="Verträge anlegen und Konten zuordnen. Aus angenommenen Angeboten entstehen Verträge automatisch."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Vertrag anlegen
                </h2>
                <ContractForm accounts={accounts} />
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Alle Verträge
                </h2>
                <AdminContractsTable
                    rows={contracts.map((entry) => ({
                        id: entry.id,
                        number: entry.number,
                        title: entry.title,
                        status: entry.status as keyof typeof CONTRACT_STATUS_LABEL,
                        serviceReadyAt: entry.serviceReadyAt,
                        minimumTermMonths: entry.minimumTermMonths,
                        monthlyPriceCents: entry.monthlyPriceCents,
                        terminatedTo: entry.terminatedTo,
                        email: entry.email,
                        earliestTermination: dateInputValue(
                            earliestTerminationDate(entry, today),
                        ),
                    }))}
                />
            </div>
        </>
    );
}
