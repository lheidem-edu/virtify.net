import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "@/lib/crypto";
import {
    authenticateApiKey,
    contextCan,
    createApiKey,
    generateToken,
    revokeApiKey,
    TOKEN_PREFIX,
} from "@/server/api-keys";
import { setRoles } from "@/server/auth/roles";
import { createCustomerForUser } from "@/server/customers/repository";
import {
    createTestDatabase,
    databaseAvailable,
    schema,
    type TestDb,
} from "../helpers/database";

/**
 * What a key may reach. The rule the panel rests on is that a key is never
 * more than its owner: a customer's key sees that customer, a staff key sees
 * what that employee's roles allow today — not what they allowed when the key
 * was made.
 */

describe("the token itself", () => {
    it("carries a recognisable prefix and is stored only as a hash", () => {
        const secret = generateToken();

        expect(secret.token.startsWith(TOKEN_PREFIX)).toBe(true);
        expect(secret.prefix).toBe(secret.token.slice(0, 12));
        expect(secret.tokenHash).toBe(hashToken(secret.token));
        expect(secret.tokenHash).not.toContain(secret.token);
    });

    it("does not repeat itself", () => {
        const seen = new Set(
            Array.from({ length: 200 }, () => generateToken().token),
        );

        expect(seen.size).toBe(200);
    });
});

const available = await databaseAvailable();

describe.skipIf(!available)("what a key may reach", () => {
    let db: TestDb;
    let drop: () => Promise<void>;

    const staffUserId = "staffuser_01MTESTKEYSAAAAAAAAAAAAAA";
    const otherUserId = "user_01MTESTKEYUSERAAAAAAAAAAA";
    const strangerUserId = "user_01MTESTKEYSTRANGERAAAAAA";

    let customerId = "";
    let strangerId = "";
    let billingRoleId = "";
    let staffToken = "";
    let customerToken = "";

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());

        await db.insert(schema.staffUser).values({
            id: staffUserId,
            name: "Buchhaltung",
            email: "buchhaltung@example.test",
            emailVerified: true,
        });

        const [role] = await db
            .insert(schema.staffRole)
            .values({
                name: "Buchhaltung",
                permissions: ["customers.read", "billing.read"],
            })
            .returning();

        billingRoleId = role.id;

        await db.insert(schema.staffRoleAssignment).values({
            staffUserId,
            roleId: billingRoleId,
        });

        for (const [userId, label] of [
            [otherUserId, "eigen"],
            [strangerUserId, "fremd"],
        ]) {
            await db.insert(schema.user).values({
                id: userId,
                name: label,
                email: `${label}@example.test`,
                emailVerified: true,
            });

            const customer = await createCustomerForUser(db, {
                id: userId,
                name: label,
                email: `${label}@example.test`,
            });

            if (userId === otherUserId) {
                customerId = customer.id;
            } else {
                strangerId = customer.id;
            }
        }

        staffToken = (
            await createApiKey(
                db,
                {
                    name: "Verwaltung",
                    scopes: ["customers.read", "customers.write"],
                    owner: { type: "staff", staffUserId },
                },
                { type: "staff", id: staffUserId },
            )
        ).token;

        customerToken = (
            await createApiKey(
                db,
                {
                    name: "Mein Schlüssel",
                    scopes: ["customers.read", "billing.read"],
                    owner: { type: "customer", customerId },
                },
                { type: "customer", id: otherUserId },
            )
        ).token;
    });

    afterAll(async () => {
        await drop?.();
    });

    it("stores no token, only its hash and a display prefix", async () => {
        const [row] = await db
            .select()
            .from(schema.apiKey)
            .where(eq(schema.apiKey.tokenHash, hashToken(customerToken)));

        expect(row).toBeDefined();
        expect(row.prefix).toBe(customerToken.slice(0, 12));
        expect(JSON.stringify(row)).not.toContain(customerToken);
    });

    it("binds a customer key to exactly one account", async () => {
        const context = await authenticateApiKey(db, customerToken);

        expect(context?.owner).toEqual({ type: "customer", customerId });
        expect(context?.owner).not.toEqual({
            type: "customer",
            customerId: strangerId,
        });
    });

    it("narrows a staff key to the roles its owner holds today", async () => {
        const context = await authenticateApiKey(db, staffToken);

        // The key asked for customers.write; the role grants only read, so
        // that is all the key gets — the key cannot be more than its owner.
        expect(context?.permissions).toEqual(["customers.read"]);
        expect(context && contextCan(context, "customers.read")).toBe(true);
        expect(context && contextCan(context, "customers.write")).toBe(false);
    });

    it("shrinks with its owner when a role is taken away", async () => {
        await setRoles(db, staffUserId, [], { type: "staff", id: "system" });

        const context = await authenticateApiKey(db, staffToken);

        expect(context?.permissions).toEqual([]);
        expect(context && contextCan(context, "customers.read")).toBe(false);

        await db.insert(schema.staffRoleAssignment).values({
            staffUserId,
            roleId: billingRoleId,
        });
    });

    it("refuses a customer key a scope customers may never hold", async () => {
        const { token } = await createApiKey(
            db,
            {
                name: "Zu viel verlangt",
                // Nothing stops a caller from asking; what stops it is that
                // the scope is filtered out when the key is used.
                scopes: ["settings.write", "customers.read"],
                owner: { type: "customer", customerId },
            },
            { type: "customer", id: otherUserId },
        );

        const context = await authenticateApiKey(db, token);

        expect(context?.permissions).toEqual(["customers.read"]);
        expect(context && contextCan(context, "settings.write")).toBe(false);
    });

    it("rejects an unknown, a malformed and an empty token", async () => {
        expect(await authenticateApiKey(db, "nonsense")).toBeNull();
        expect(await authenticateApiKey(db, "")).toBeNull();
        expect(
            await authenticateApiKey(db, `${TOKEN_PREFIX}doesnotexist`),
        ).toBeNull();
    });

    it("rejects a revoked key", async () => {
        const { key, token } = await createApiKey(
            db,
            {
                name: "Kurzlebig",
                scopes: ["customers.read"],
                owner: { type: "customer", customerId },
            },
            { type: "customer", id: otherUserId },
        );

        expect(await authenticateApiKey(db, token)).not.toBeNull();

        await revokeApiKey(
            db,
            key.id,
            { type: "customer", customerId },
            { type: "customer", id: otherUserId },
        );

        expect(await authenticateApiKey(db, token)).toBeNull();
    });

    it("rejects an expired key", async () => {
        const { token } = await createApiKey(
            db,
            {
                name: "Abgelaufen",
                scopes: ["customers.read"],
                owner: { type: "customer", customerId },
                expiresAt: new Date(Date.now() - 1000),
            },
            { type: "customer", id: otherUserId },
        );

        expect(await authenticateApiKey(db, token)).toBeNull();
    });

    it("will not let one customer revoke another's key", async () => {
        const { key } = await createApiKey(
            db,
            {
                name: "Nicht deiner",
                scopes: ["customers.read"],
                owner: { type: "customer", customerId },
            },
            { type: "customer", id: otherUserId },
        );

        const revoked = await revokeApiKey(
            db,
            key.id,
            { type: "customer", customerId: strangerId },
            { type: "customer", id: strangerUserId },
        );

        expect(revoked).toBeNull();

        const [row] = await db
            .select()
            .from(schema.apiKey)
            .where(eq(schema.apiKey.id, key.id));

        expect(row.revokedAt).toBeNull();
    });

    it("refuses a key with neither owner, at the database", async () => {
        await expect(
            db.insert(schema.apiKey).values({
                name: "Niemandes",
                tokenHash: hashToken("vfy_orphan"),
                prefix: "vfy_orph",
                scopes: [],
            }),
        ).rejects.toThrow();
    });

    it("refuses a key with both owners, at the database", async () => {
        await expect(
            db.insert(schema.apiKey).values({
                name: "Beides",
                tokenHash: hashToken("vfy_both"),
                prefix: "vfy_both",
                scopes: [],
                customerId,
                staffUserId,
            }),
        ).rejects.toThrow();
    });

    it("notes when a key was last used", async () => {
        await authenticateApiKey(db, customerToken);

        const [row] = await db
            .select()
            .from(schema.apiKey)
            .where(eq(schema.apiKey.tokenHash, hashToken(customerToken)));

        expect(row.lastUsedAt).toBeInstanceOf(Date);
    });

    it("logs creation and revocation", async () => {
        const log = await db
            .select()
            .from(schema.auditLog)
            .where(eq(schema.auditLog.entityType, "api_key"));

        expect(log.some((row) => row.action === "api_key.create")).toBe(true);
        expect(log.some((row) => row.action === "api_key.revoke")).toBe(true);
    });
});
