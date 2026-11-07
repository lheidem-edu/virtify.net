import "server-only";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import type { GatewayId } from "./settings";

/**
 * The authorisations a customer has left behind so a renewal can be collected
 * without them.
 *
 * We never see a card number or an IBAN: what is stored is the provider's own
 * token and a label the customer recognises. A method is *revoked*, never
 * deleted, because a payment collected through it has to keep pointing at
 * something — and the provider's detach is irreversible, so the row ends up
 * being the only record that it ever existed.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export type StorableProvider = Extract<GatewayId, "stripe" | "paypal">;

/**
 * Writes the token the customer just approved.
 *
 * The unique token is what makes this safe to repeat: storing the same card
 * twice revives the existing row instead of failing, and a method stored
 * again after removal comes back rather than duplicating. `setWhere` keeps
 * that from working **across accounts** — without it, presenting a token that
 * belongs to somebody else would revive their withdrawn authorisation and
 * hand it to whoever asked.
 */
export async function storeMethod(
    db: Db,
    input: {
        customerId: string;
        provider: StorableProvider;
        token: string;
        label: string;
        contractId?: string | null;
        /** First one stored becomes the default; later ones only if asked. */
        makeDefault?: boolean;
        actor: Actor;
    },
): Promise<{ id: string } | null> {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .insert(schema.paymentMethod)
            .values({
                id: createId("paymentmethod"),
                customerId: input.customerId,
                provider: input.provider,
                token: input.token,
                label: input.label,
            })
            .onConflictDoUpdate({
                target: schema.paymentMethod.token,
                set: { label: input.label, revokedAt: null },
                setWhere: eq(schema.paymentMethod.customerId, input.customerId),
            })
            .returning({ id: schema.paymentMethod.id });

        if (!row) {
            return null;
        }

        const live = await liveMethods(tx, input.customerId);
        const shouldDefault =
            input.makeDefault === true ||
            !live.some((method) => method.isDefault);

        if (shouldDefault) {
            await makeDefaultIn(tx, input.customerId, row.id);
        }

        if (input.contractId) {
            // The setup was started from a contract, which is that contract's
            // authorisation — but only for a contract still being invoiced,
            // and only for one of this account's.
            await tx
                .update(schema.contract)
                .set({ paymentMethodId: row.id, updatedAt: new Date() })
                .where(
                    and(
                        eq(schema.contract.id, input.contractId),
                        eq(schema.contract.customerId, input.customerId),
                        inArray(schema.contract.status, [
                            "provisioning",
                            "active",
                        ]),
                    ),
                );
        }

        await audit(tx, {
            actor: input.actor,
            action: "payment_method.store",
            entityType: "payment_method",
            entityId: row.id,
            after: {
                provider: input.provider,
                label: input.label,
                isDefault: shouldDefault,
            },
        });

        return { id: row.id };
    });
}

export async function liveMethods(executor: Executor, customerId: string) {
    return executor
        .select()
        .from(schema.paymentMethod)
        .where(
            and(
                eq(schema.paymentMethod.customerId, customerId),
                isNull(schema.paymentMethod.revokedAt),
            ),
        )
        .orderBy(asc(schema.paymentMethod.id));
}

/** The one an automatic collection reaches for, if the account has one. */
export async function defaultMethod(executor: Executor, customerId: string) {
    const methods = await liveMethods(executor, customerId);

    return methods.find((method) => method.isDefault) ?? null;
}

/**
 * Exactly one default per account. The partial unique index would refuse two,
 * so the old one is cleared first — in the same transaction, which is what
 * makes two browser tabs harmless.
 */
async function makeDefaultIn(tx: Tx, customerId: string, methodId: string) {
    await tx
        .update(schema.paymentMethod)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
            and(
                eq(schema.paymentMethod.customerId, customerId),
                eq(schema.paymentMethod.isDefault, true),
                ne(schema.paymentMethod.id, methodId),
            ),
        );

    await tx
        .update(schema.paymentMethod)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(
            and(
                eq(schema.paymentMethod.id, methodId),
                eq(schema.paymentMethod.customerId, customerId),
                isNull(schema.paymentMethod.revokedAt),
            ),
        );
}

export async function setDefaultMethod(
    db: Db,
    input: { customerId: string; methodId: string; actor: Actor },
): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [method] = await tx
            .select({ id: schema.paymentMethod.id })
            .from(schema.paymentMethod)
            .where(
                and(
                    eq(schema.paymentMethod.id, input.methodId),
                    eq(schema.paymentMethod.customerId, input.customerId),
                    isNull(schema.paymentMethod.revokedAt),
                ),
            );

        if (!method) {
            return false;
        }

        await makeDefaultIn(tx, input.customerId, input.methodId);

        await audit(tx, {
            actor: input.actor,
            action: "payment_method.default",
            entityType: "payment_method",
            entityId: input.methodId,
            after: { isDefault: true },
        });

        return true;
    });
}

/**
 * Withdraws an authorisation.
 *
 * Revoking always works here; deleting it at the provider can fail, and the
 * difference is what the customer was promised — so `detached_at` records
 * which of the two actually happened instead of the code assuming.
 *
 * A revoked method that was the default leaves the account without one. That
 * is deliberate: silently promoting another card would be us choosing which
 * card the customer is charged on.
 */
export async function revokeMethod(
    db: Db,
    input: { customerId: string; methodId: string; actor: Actor },
): Promise<{ ok: boolean; token?: string; provider?: StorableProvider }> {
    const result = await db.transaction(async (tx) => {
        const [method] = await tx
            .select()
            .from(schema.paymentMethod)
            .where(
                and(
                    eq(schema.paymentMethod.id, input.methodId),
                    eq(schema.paymentMethod.customerId, input.customerId),
                    isNull(schema.paymentMethod.revokedAt),
                ),
            )
            .for("update");

        if (!method) {
            return { ok: false as const };
        }

        const now = new Date();

        await tx
            .update(schema.paymentMethod)
            .set({ revokedAt: now, isDefault: false, updatedAt: now })
            .where(eq(schema.paymentMethod.id, method.id));

        // A subscription that was collecting through it stops doing so. The
        // subscription itself is untouched — losing a card does not end a
        // contract, it only means the next invoice wants paying by hand.
        await tx
            .update(schema.subscription)
            .set({ paymentMethodId: null, autoCharge: false, updatedAt: now })
            .where(eq(schema.subscription.paymentMethodId, method.id));

        await tx
            .update(schema.contract)
            .set({ paymentMethodId: null, updatedAt: now })
            .where(eq(schema.contract.paymentMethodId, method.id));

        await audit(tx, {
            actor: input.actor,
            action: "payment_method.revoke",
            entityType: "payment_method",
            entityId: method.id,
            before: { revokedAt: null },
            after: { revokedAt: now.toISOString() },
        });

        return {
            ok: true as const,
            token: method.token,
            provider: method.provider as StorableProvider,
        };
    });

    return result;
}

/** Records that the provider confirmed the token is gone on their side. */
export async function markDetached(db: Db, methodId: string) {
    await db
        .update(schema.paymentMethod)
        .set({ detachedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.paymentMethod.id, methodId));
}

/**
 * Claims a setup the customer started. The row was written before the
 * redirect, so a provider id that was never ours is worth nothing — which is
 * what stops somebody pasting another account's session id into the return
 * URL.
 */
export async function claimSetup(
    db: Db,
    input: { id: string; customerId: string; provider: StorableProvider },
): Promise<{ contractId: string | null } | null> {
    const [row] = await db
        .delete(schema.paymentSetup)
        .where(
            and(
                eq(schema.paymentSetup.id, input.id),
                eq(schema.paymentSetup.customerId, input.customerId),
                eq(schema.paymentSetup.provider, input.provider),
            ),
        )
        .returning({ contractId: schema.paymentSetup.contractId });

    return row ?? null;
}

export async function recordSetup(
    db: Db,
    input: {
        id: string;
        customerId: string;
        provider: StorableProvider;
        contractId?: string | null;
    },
) {
    await db
        .insert(schema.paymentSetup)
        .values({
            id: input.id,
            customerId: input.customerId,
            provider: input.provider,
            contractId: input.contractId ?? null,
        })
        .onConflictDoNothing();
}
