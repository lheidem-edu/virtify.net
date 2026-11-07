import ApiKeyManager from "@/components/shared/api-key-manager";
import PageHeader from "@/components/shared/page-header";
import { db } from "@/db";
import { listApiKeys } from "@/server/api-keys";
import { ALL_PERMISSIONS, PERMISSIONS } from "@/server/auth/permissions";
import { requirePermission } from "@/server/auth/staff-session";
import { createStaffKey, revokeStaffKey } from "./actions";

export const dynamic = "force-dynamic";

export default async function Page() {
    const session = await requirePermission("apikeys.manage");

    const keys = await listApiKeys(db, {
        type: "staff",
        staffUserId: session.user.id,
    });

    return (
        <>
            <PageHeader
                title="API-Schlüssel"
                intro="Schlüssel für die REST-Schnittstelle. Sie gehören dir persönlich und können nie mehr als du selbst — nimmt man dir eine Rolle, schrumpft auch der Schlüssel."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <ApiKeyManager
                    keys={keys}
                    scopes={ALL_PERMISSIONS.map((value) => ({
                        value,
                        label: PERMISSIONS[value],
                    }))}
                    createAction={createStaffKey}
                    revokeAction={revokeStaffKey}
                />
            </div>
        </>
    );
}
