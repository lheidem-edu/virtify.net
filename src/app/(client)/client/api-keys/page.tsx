import ApiKeyManager from "@/components/shared/api-key-manager";
import PageHeader from "@/components/shared/page-header";
import { db } from "@/db";
import { CUSTOMER_SCOPES, listApiKeys } from "@/server/api-keys";
import { PERMISSIONS } from "@/server/auth/permissions";
import { getCurrentCustomer } from "@/server/customers/current";
import { createCustomerKey, revokeCustomerKey } from "./actions";

export const dynamic = "force-dynamic";

export default async function Page() {
    const { customer } = await getCurrentCustomer();

    const keys = await listApiKeys(db, {
        type: "customer",
        customerId: customer.id,
    });

    return (
        <>
            <PageHeader
                title="API-Schlüssel"
                intro="Für den Zugriff auf deine eigenen Daten über die Schnittstelle. Ein Schlüssel sieht ausschließlich dein Kundenkonto — und wird genau einmal angezeigt."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <ApiKeyManager
                    keys={keys}
                    scopes={CUSTOMER_SCOPES.map((value) => ({
                        value,
                        label: PERMISSIONS[value],
                    }))}
                    createAction={createCustomerKey}
                    revokeAction={revokeCustomerKey}
                />
            </div>
        </>
    );
}
