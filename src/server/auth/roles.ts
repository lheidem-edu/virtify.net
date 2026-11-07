import { asc, eq, inArray } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { type Actor, audit, diff } from "@/server/audit";
import {
    PERMISSIONS,
    type Permission,
    SUPER_ADMIN_ROLE,
    WILDCARD,
} from "@/server/auth/permissions";

/**
 * Managing roles. Kept apart from `permissions.ts`, which only answers what
 * somebody may do — this file is what changes the answer, and so is the one
 * that has to be audited.
 */

type Db = typeof defaultDb;

export class RoleError extends Error {}

export async function listRoles(db: Db) {
    return db
        .select()
        .from(schema.staffRole)
        .orderBy(asc(schema.staffRole.name));
}

export async function listAssignments(db: Db, staffUserIds: string[]) {
    if (staffUserIds.length === 0) {
        return [];
    }

    return db
        .select({
            staffUserId: schema.staffRoleAssignment.staffUserId,
            roleId: schema.staffRole.id,
            roleName: schema.staffRole.name,
        })
        .from(schema.staffRoleAssignment)
        .innerJoin(
            schema.staffRole,
            eq(schema.staffRoleAssignment.roleId, schema.staffRole.id),
        )
        .where(inArray(schema.staffRoleAssignment.staffUserId, staffUserIds));
}

function validate(permissions: string[]) {
    const unknown = permissions.filter(
        (entry) => entry !== WILDCARD && !(entry in PERMISSIONS),
    );

    if (unknown.length > 0) {
        throw new RoleError(`Unbekannte Berechtigung: ${unknown.join(", ")}`);
    }
}

export async function createRole(
    db: Db,
    input: { name: string; description?: string | null; permissions: string[] },
    actor: Actor,
) {
    validate(input.permissions);

    return db.transaction(async (tx) => {
        const [row] = await tx
            .insert(schema.staffRole)
            .values({
                name: input.name,
                description: input.description ?? null,
                permissions: input.permissions,
            })
            .returning();

        await audit(tx, {
            actor,
            action: "staff_role.create",
            entityType: "staff_role",
            entityId: row.id,
            after: { name: row.name, permissions: row.permissions },
        });

        return row;
    });
}

/**
 * The seeded Super Admin is deliberately immovable: an account that can edit
 * roles could otherwise take the last unrestricted role away and lock every
 * employee out of the panel with no way back in through the application.
 */
export async function updateRolePermissions(
    db: Db,
    roleId: string,
    permissions: Permission[],
    actor: Actor,
) {
    validate(permissions);

    return db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(schema.staffRole)
            .where(eq(schema.staffRole.id, roleId));

        if (!before) {
            throw new RoleError("Diese Rolle gibt es nicht.");
        }

        if (before.isSystem) {
            throw new RoleError(
                `„${SUPER_ADMIN_ROLE}“ lässt sich nicht einschränken.`,
            );
        }

        const [row] = await tx
            .update(schema.staffRole)
            .set({ permissions, updatedAt: new Date() })
            .where(eq(schema.staffRole.id, roleId))
            .returning();

        await audit(tx, {
            actor,
            action: "staff_role.update",
            entityType: "staff_role",
            entityId: roleId,
            before: { permissions: before.permissions },
            after: { permissions: row.permissions },
        });

        return row;
    });
}

export async function deleteRole(db: Db, roleId: string, actor: Actor) {
    return db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(schema.staffRole)
            .where(eq(schema.staffRole.id, roleId));

        if (!before) {
            throw new RoleError("Diese Rolle gibt es nicht.");
        }

        if (before.isSystem) {
            throw new RoleError(
                `„${SUPER_ADMIN_ROLE}“ lässt sich nicht löschen.`,
            );
        }

        await tx
            .delete(schema.staffRole)
            .where(eq(schema.staffRole.id, roleId));

        await audit(tx, {
            actor,
            action: "staff_role.delete",
            entityType: "staff_role",
            entityId: roleId,
            before: { name: before.name, permissions: before.permissions },
        });
    });
}

/**
 * Replaces an employee's roles with exactly this set. Refuses to remove the
 * last holder of an unrestricted role for the same reason the role itself
 * cannot be edited.
 */
export async function setRoles(
    db: Db,
    staffUserId: string,
    roleIds: string[],
    actor: Actor,
) {
    return db.transaction(async (tx) => {
        const before = await tx
            .select({ roleId: schema.staffRoleAssignment.roleId })
            .from(schema.staffRoleAssignment)
            .where(eq(schema.staffRoleAssignment.staffUserId, staffUserId));

        const [superAdmin] = await tx
            .select()
            .from(schema.staffRole)
            .where(eq(schema.staffRole.isSystem, true));

        if (
            superAdmin &&
            before.some((entry) => entry.roleId === superAdmin.id) &&
            !roleIds.includes(superAdmin.id)
        ) {
            const holders = await tx
                .select({ id: schema.staffRoleAssignment.id })
                .from(schema.staffRoleAssignment)
                .where(eq(schema.staffRoleAssignment.roleId, superAdmin.id));

            if (holders.length <= 1) {
                throw new RoleError(
                    `Das ist der letzte „${SUPER_ADMIN_ROLE}“. Ohne ihn kommt niemand mehr an die Rollen.`,
                );
            }
        }

        await tx
            .delete(schema.staffRoleAssignment)
            .where(eq(schema.staffRoleAssignment.staffUserId, staffUserId));

        if (roleIds.length > 0) {
            await tx
                .insert(schema.staffRoleAssignment)
                .values(roleIds.map((roleId) => ({ staffUserId, roleId })));
        }

        const changes = diff(
            {
                roles: before
                    .map((entry) => entry.roleId)
                    .sort()
                    .join(","),
            },
            { roles: [...roleIds].sort().join(",") },
        );

        if (changes) {
            await audit(tx, {
                actor,
                action: "staff_user.roles",
                entityType: "staff_user",
                entityId: staffUserId,
                before: changes.before,
                after: changes.after,
            });
        }
    });
}
