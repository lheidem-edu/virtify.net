import { and, asc, eq, isNull } from "drizzle-orm";
import PageHeader from "@/components/shared/page-header";
import { db, schema } from "@/db";
import type { CONTRACT_STATUS_LABEL } from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { listContracts } from "@/server/documents/repository";
import ContractsTable from "./contracts-table";

export default async function Page() {
    const { customer } = await getCurrentCustomer();

    const [contracts, methods, collection] = await Promise.all([
        listContracts(customer.id, false),
        db
            .select({
                id: schema.paymentMethod.id,
                label: schema.paymentMethod.label,
            })
            .from(schema.paymentMethod)
            .where(
                and(
                    eq(schema.paymentMethod.customerId, customer.id),
                    isNull(schema.paymentMethod.revokedAt),
                ),
            )
            .orderBy(asc(schema.paymentMethod.createdAt)),
        // Which method each contract is collected from. Kept out of the
        // shared loader, which every document list uses and none of the
        // others needs this for.
        db
            .select({
                id: schema.contract.id,
                paymentMethodId: schema.contract.paymentMethodId,
            })
            .from(schema.contract)
            .where(eq(schema.contract.customerId, customer.id)),
    ]);

    const byContract = new Map(
        collection.map((entry) => [entry.id, entry.paymentMethodId]),
    );
    const byMethod = new Map(methods.map((entry) => [entry.id, entry.label]));

    return (
        <>
            <PageHeader
                title="Verträge"
                intro="Deine laufenden und beendeten Verträge. Für laufende Verträge kannst du festlegen, ob wir die Rechnungen selbst einziehen."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <ContractsTable
                    rows={contracts.map((entry) => {
                        const paymentMethodId =
                            byContract.get(entry.id) ?? null;

                        return {
                            ...entry,
                            status: entry.status as keyof typeof CONTRACT_STATUS_LABEL,
                            paymentMethodId,
                            paymentMethodLabel: paymentMethodId
                                ? (byMethod.get(paymentMethodId) ?? null)
                                : null,
                        };
                    })}
                    methods={methods}
                />
            </div>
        </>
    );
}
