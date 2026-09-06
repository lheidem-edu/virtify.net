import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { listContracts } from "@/lib/documents/repository";
import type { CONTRACT_STATUS_LABEL } from "@/lib/format";
import ContractsTable from "./contracts-table";

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
                <ContractsTable
                    rows={contracts.map((entry) => ({
                        ...entry,
                        status: entry.status as keyof typeof CONTRACT_STATUS_LABEL,
                    }))}
                />
            </div>
        </>
    );
}
