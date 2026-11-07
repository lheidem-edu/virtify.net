import { asc } from "drizzle-orm";
import PageHeader from "@/components/shared/page-header";
import { db, schema } from "@/db";
import { ALL_PERMISSIONS, PERMISSIONS } from "@/server/auth/permissions";
import { listAssignments, listRoles } from "@/server/auth/roles";
import { requirePermission } from "@/server/auth/staff-session";
import { MemberRoles, NewRole, RoleCard } from "./role-forms";

export const dynamic = "force-dynamic";

export default async function Page() {
    await requirePermission("roles.manage");

    const roles = await listRoles(db);
    const members = await db
        .select({
            id: schema.staffUser.id,
            name: schema.staffUser.name,
            email: schema.staffUser.email,
        })
        .from(schema.staffUser)
        .orderBy(asc(schema.staffUser.email));

    const assignments = await listAssignments(
        db,
        members.map((entry) => entry.id),
    );

    const catalogue = ALL_PERMISSIONS.map((value) => ({
        value,
        label: PERMISSIONS[value],
    }));

    return (
        <>
            <PageHeader
                title="Rollen"
                intro="Eine Rolle bündelt Berechtigungen; ein Mitarbeiter darf, was irgendeine seiner Rollen erlaubt. Wer keine Rolle hat, darf nichts."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Rolle anlegen
                </h2>
                <NewRole catalogue={catalogue} />
            </div>

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Rollen
                </h2>
                <div className="space-y-6">
                    {roles.map((role) => (
                        <RoleCard
                            key={role.id}
                            role={role}
                            catalogue={catalogue}
                        />
                    ))}
                </div>
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Zuordnung
                </h2>
                <div className="space-y-4">
                    {members.map((member) => (
                        <MemberRoles
                            key={member.id}
                            member={{
                                ...member,
                                roleIds: assignments
                                    .filter(
                                        (entry) =>
                                            entry.staffUserId === member.id,
                                    )
                                    .map((entry) => entry.roleId),
                            }}
                            roles={roles}
                        />
                    ))}
                </div>
            </div>
        </>
    );
}
