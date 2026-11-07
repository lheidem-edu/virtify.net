import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { hashToken } from "@/lib/crypto";
import { type Actor, audit } from "@/server/audit";
import {
    hasPermission,
    type Permission,
    permissionsForStaff,
} from "@/server/auth/permissions";

/**
 * API keys: minted once, hashed at rest, scoped to an owner.
 *
 * A key is never more than its owner. A customer's key reads that customer's
 * rows and nothing else — not because the endpoints remember to check, but
 * because the authenticated context carries the customer id and the queries
 * take it from there.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

/** Recognisable in a log and in a leaked repository search. */
export const TOKEN_PREFIX = "vfy_";

/** 32 bytes of randomness, base64url — 43 characters after the prefix. */
const TOKEN_BYTES = 32;

/** How much of the token is kept in clear so a key can be told apart. */
const DISPLAY_LENGTH = TOKEN_PREFIX.length + 8;

export type ApiKeyOwner =
    | { type: "staff"; staffUserId: string }
    | { type: "customer"; customerId: string };

export function generateToken() {
    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;

    return {
        token,
        prefix: token.slice(0, DISPLAY_LENGTH),
        tokenHash: hashToken(token),
    };
}

/**
 * The scopes a customer's key may ever carry. A customer cannot mint a key
 * that reads the settings or another account, whatever it asks for.
 */
export const CUSTOMER_SCOPES = [
    "customers.read",
    "customers.write",
    "billing.read",
    "offers.read",
    "contracts.read",
    "payments.read",
    // The catalog is what a customer orders from. Reading it is the first
    // step of every order, and nothing in it is anyone's private data.
    "catalog.read",
] as const satisfies readonly Permission[];

export type CustomerScope = (typeof CUSTOMER_SCOPES)[number];

export async function createApiKey(
    db: Db,
    input: {
        name: string;
        scopes: readonly Permission[];
        owner: ApiKeyOwner;
        expiresAt?: Date | null;
    },
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    const secret = generateToken();

    return db.transaction(async (tx) => {
        const [row] = await tx
            .insert(schema.apiKey)
            .values({
                name: input.name,
                tokenHash: secret.tokenHash,
                prefix: secret.prefix,
                scopes: [...input.scopes],
                expiresAt: input.expiresAt ?? null,
                customerId:
                    input.owner.type === "customer"
                        ? input.owner.customerId
                        : null,
                staffUserId:
                    input.owner.type === "staff"
                        ? input.owner.staffUserId
                        : null,
            })
            .returning();

        await audit(tx, {
            actor,
            action: "api_key.create",
            entityType: "api_key",
            entityId: row.id,
            after: { name: row.name, prefix: row.prefix, scopes: row.scopes },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        // The only time the token exists outside the caller's hands.
        return { key: row, token: secret.token };
    });
}

/**
 * Revoking is scoped by owner on purpose: the id alone would let a customer
 * revoke a key that is not theirs by guessing one.
 */
export async function revokeApiKey(
    db: Db,
    id: string,
    owner: ApiKeyOwner,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .update(schema.apiKey)
            .set({ revokedAt: new Date(), updatedAt: new Date() })
            .where(
                and(
                    eq(schema.apiKey.id, id),
                    ownedBy(owner),
                    isNull(schema.apiKey.revokedAt),
                ),
            )
            .returning();

        if (!row) {
            return null;
        }

        await audit(tx, {
            actor,
            action: "api_key.revoke",
            entityType: "api_key",
            entityId: row.id,
            before: { revokedAt: null },
            after: { revokedAt: row.revokedAt },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

function ownedBy(owner: ApiKeyOwner) {
    return owner.type === "staff"
        ? eq(schema.apiKey.staffUserId, owner.staffUserId)
        : eq(schema.apiKey.customerId, owner.customerId);
}

export async function listApiKeys(db: Executor, owner: ApiKeyOwner) {
    return db
        .select({
            id: schema.apiKey.id,
            name: schema.apiKey.name,
            prefix: schema.apiKey.prefix,
            scopes: schema.apiKey.scopes,
            lastUsedAt: schema.apiKey.lastUsedAt,
            expiresAt: schema.apiKey.expiresAt,
            revokedAt: schema.apiKey.revokedAt,
            createdAt: schema.apiKey.createdAt,
        })
        .from(schema.apiKey)
        .where(ownedBy(owner))
        .orderBy(asc(schema.apiKey.id));
}

export type ApiContext =
    | {
          key: typeof schema.apiKey.$inferSelect;
          owner: { type: "staff"; staffUserId: string };
          /** The staff user's own permissions, intersected with the scopes. */
          permissions: string[];
      }
    | {
          key: typeof schema.apiKey.$inferSelect;
          owner: { type: "customer"; customerId: string };
          permissions: string[];
      };

/**
 * Resolves a bearer token to what it may do.
 *
 * A staff key is bounded twice: by its scopes and by what its owner's roles
 * grant today. Taking the roles away takes the key's reach with it, which is
 * the behaviour the operator expects when they remove somebody's access.
 */
export async function authenticateApiKey(
    db: Db,
    token: string,
): Promise<ApiContext | null> {
    if (!token.startsWith(TOKEN_PREFIX)) {
        return null;
    }

    const [row] = await db
        .select()
        .from(schema.apiKey)
        .where(eq(schema.apiKey.tokenHash, hashToken(token)))
        .limit(1);

    if (!row || row.revokedAt) {
        return null;
    }

    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
        return null;
    }

    // Best effort: a failed bookkeeping write must not refuse a valid key.
    await db
        .update(schema.apiKey)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.apiKey.id, row.id));

    if (row.staffUserId) {
        const granted = await permissionsForStaff(db, row.staffUserId);

        return {
            key: row,
            owner: { type: "staff", staffUserId: row.staffUserId },
            permissions: row.scopes.filter((scope) =>
                hasPermission(granted, scope as Permission),
            ),
        };
    }

    if (row.customerId) {
        return {
            key: row,
            owner: { type: "customer", customerId: row.customerId },
            permissions: row.scopes.filter((scope) =>
                (CUSTOMER_SCOPES as readonly string[]).includes(scope),
            ),
        };
    }

    return null;
}

export function contextCan(context: ApiContext, needed: Permission): boolean {
    return hasPermission(context.permissions, needed);
}
