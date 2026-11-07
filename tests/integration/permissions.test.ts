import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    assertStaffPermission,
    hasPermission,
    PermissionDeniedError,
    permissionsForStaff,
    staffCan,
} from "@/server/auth/permissions";
import {
    RoleError,
    setRoles,
    updateRolePermissions,
} from "@/server/auth/roles";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * Permission checks refuse. Two halves: the matching itself, which is pure
 * and needs nothing, and the resolution through roles, which is a query and
 * therefore wants a database.
 */

describe("permission matching", () => {
    it("accepts the permission itself", () => {
        expect(hasPermission(["billing.write"], "billing.write")).toBe(true);
    });

    it("refuses one it was not given", () => {
        expect(hasPermission(["billing.read"], "billing.write")).toBe(false);
        expect(hasPermission([], "billing.write")).toBe(false);
    });

    it("does not let one domain leak into another", () => {
        expect(hasPermission(["billing.*"], "customers.write")).toBe(false);
        expect(hasPermission(["customers.read"], "customers.write")).toBe(
            false,
        );
    });

    it("honours a domain wildcard, so a later phase's verb is covered", () => {
        expect(hasPermission(["tickets.*"], "tickets.reply")).toBe(true);
        expect(hasPermission(["tickets.*"], "tickets.read")).toBe(true);
    });

    it("honours the full wildcard the Super Admin holds", () => {
        expect(hasPermission(["*"], "settings.write")).toBe(true);
        expect(hasPermission(["*"], "roles.manage")).toBe(true);
    });

    it("is not fooled by a prefix that only looks like one", () => {
        expect(hasPermission(["billing"], "billing.write")).toBe(false);
        expect(hasPermission(["billing.writes"], "billing.write")).toBe(false);
    });
});

const available = await databaseAvailable();

describe.skipIf(!available)("permissions through roles", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    const superAdmin = "staffuser_01MTESTSUPERAAAAAAAAAAAAAA";
    const bookkeeper = "staffuser_01MTESTBOOKKEEPERAAAAAAAA";
    const newcomer = "staffuser_01MTESTNEWCOMERAAAAAAAAA";

    let superRoleId = "";
    let billingRoleId = "";

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        for (const [id, name] of [
            [superAdmin, "Chefin"],
            [bookkeeper, "Buchhaltung"],
            [newcomer, "Neu"],
        ]) {
            await db.insert(schema.staffUser).values({
                id,
                name,
                email: `${name.toLowerCase()}@example.test`,
                emailVerified: true,
            });
        }

        // The migration seeds "Super Admin"; this is the row it wrote.
        const [seeded] = await db
            .select()
            .from(schema.staffRole)
            .where(eq(schema.staffRole.isSystem, true));

        superRoleId = seeded.id;

        const [billing] = await db
            .insert(schema.staffRole)
            .values({
                name: "Buchhaltung",
                permissions: ["billing.read", "billing.write"],
            })
            .returning();

        billingRoleId = billing.id;

        await db.insert(schema.staffRoleAssignment).values([
            { staffUserId: superAdmin, roleId: superRoleId },
            { staffUserId: bookkeeper, roleId: billingRoleId },
        ]);
    });

    afterAll(async () => {
        await drop?.();
    });

    it("seeds a Super Admin role that grants everything", async () => {
        const granted = await permissionsForStaff(db, superAdmin);

        expect(granted).toEqual(["*"]);
        expect(await staffCan(db, superAdmin, "settings.write")).toBe(true);
        expect(await staffCan(db, superAdmin, "roles.manage")).toBe(true);
    });

    it("grants only what the employee's own role covers", async () => {
        expect(await staffCan(db, bookkeeper, "billing.write")).toBe(true);
        expect(await staffCan(db, bookkeeper, "settings.write")).toBe(false);
        expect(await staffCan(db, bookkeeper, "customers.write")).toBe(false);
    });

    it("gives an employee with no role nothing at all", async () => {
        expect(await permissionsForStaff(db, newcomer)).toEqual([]);
        expect(await staffCan(db, newcomer, "customers.read")).toBe(false);
    });

    it("throws rather than returning false, so a missing check cannot pass", async () => {
        await expect(
            assertStaffPermission(db, bookkeeper, "settings.write"),
        ).rejects.toBeInstanceOf(PermissionDeniedError);

        await expect(
            assertStaffPermission(db, bookkeeper, "billing.write"),
        ).resolves.toBeUndefined();
    });

    it("follows a role being narrowed, without touching the key or session", async () => {
        await updateRolePermissions(db, billingRoleId, ["billing.read"], {
            type: "staff",
            id: superAdmin,
        });

        expect(await staffCan(db, bookkeeper, "billing.write")).toBe(false);
        expect(await staffCan(db, bookkeeper, "billing.read")).toBe(true);
    });

    it("refuses to narrow or delete the Super Admin role", async () => {
        await expect(
            updateRolePermissions(db, superRoleId, ["billing.read"], {
                type: "staff",
                id: superAdmin,
            }),
        ).rejects.toBeInstanceOf(RoleError);
    });

    it("refuses to strip the last Super Admin of it", async () => {
        await expect(
            setRoles(db, superAdmin, [], { type: "staff", id: superAdmin }),
        ).rejects.toBeInstanceOf(RoleError);

        expect(await staffCan(db, superAdmin, "roles.manage")).toBe(true);
    });

    it("allows it once somebody else holds the role", async () => {
        await setRoles(db, newcomer, [superRoleId], {
            type: "staff",
            id: superAdmin,
        });

        await setRoles(db, superAdmin, [billingRoleId], {
            type: "staff",
            id: newcomer,
        });

        expect(await staffCan(db, superAdmin, "roles.manage")).toBe(false);
        expect(await staffCan(db, newcomer, "roles.manage")).toBe(true);
    });

    it("records every role change in the audit log", async () => {
        const log = await db
            .select()
            .from(schema.auditLog)
            .where(eq(schema.auditLog.entityType, "staff_user"));

        expect(log.length).toBeGreaterThan(0);
        expect(log.every((row) => row.action === "staff_user.roles")).toBe(
            true,
        );
    });
});
