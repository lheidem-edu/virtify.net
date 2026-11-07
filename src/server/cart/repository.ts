import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { BillingCycle, Cart, CartItem } from "@/db/schema";
import { hashToken } from "@/lib/crypto";
import { createId } from "@/lib/ulid";

/**
 * The cart, as rows.
 *
 * Two things are deliberate here and both are about trust:
 *
 * 1. **A cart stores a configuration, never a price.** What the customer
 *    sees is computed from the catalog at the moment it is shown, by the one
 *    price function. A cart that carried amounts would be a second opinion
 *    about a price, and a browser that could post one would be the author of
 *    it.
 * 2. **A guest cart is reachable only by its secret**, which is stored
 *    hashed. The row's id is a ULID — time-ordered, printed in the admin
 *    area, and no kind of credential. So one guest's cookie cannot reach
 *    another's cart, and a database dump does not hand out live carts.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

/** How long a cart's cookie survives. Long enough to come back tomorrow. */
export const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const TOKEN_BYTES = 32;

export class CartError extends Error {}

/** One chosen add-on, as the cart stores it: ids and a count, no prices. */
export type CartSelection = {
    optionId: string;
    valueId: string;
    quantity: number;
};

export function generateCartToken(): { token: string; tokenHash: string } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");

    return { token, tokenHash: hashToken(token) };
}

export async function createCart(
    tx: Executor,
    input: { customerId?: string | null; currency?: string } = {},
): Promise<{ cart: Cart; token: string }> {
    const secret = generateCartToken();

    const [row] = await tx
        .insert(schema.cart)
        .values({
            id: createId("cart"),
            tokenHash: secret.tokenHash,
            customerId: input.customerId ?? null,
            currency: input.currency ?? "EUR",
        })
        .returning();

    return { cart: row, token: secret.token };
}

/** An open cart by the secret in the cookie. Nothing else resolves one. */
export async function findCartByToken(
    tx: Executor,
    token: string,
): Promise<Cart | null> {
    const [row] = await tx
        .select()
        .from(schema.cart)
        .where(
            and(
                eq(schema.cart.tokenHash, hashToken(token)),
                eq(schema.cart.status, "open"),
            ),
        )
        .limit(1);

    return row ?? null;
}

/** One cart by id, whatever its state. */
export async function getCart(
    tx: Executor,
    cartId: string,
): Promise<Cart | null> {
    const [row] = await tx
        .select()
        .from(schema.cart)
        .where(eq(schema.cart.id, cartId))
        .limit(1);

    return row ?? null;
}

export async function findOpenCartForCustomer(
    tx: Executor,
    customerId: string,
): Promise<Cart | null> {
    const [row] = await tx
        .select()
        .from(schema.cart)
        .where(
            and(
                eq(schema.cart.customerId, customerId),
                eq(schema.cart.status, "open"),
            ),
        )
        // The newest open cart wins; older ones only exist if a merge was
        // interrupted, and the merge itself is what closes them.
        .orderBy(asc(schema.cart.id))
        .limit(1);

    return row ?? null;
}

export async function loadCartItems(
    tx: Executor,
    cartId: string,
): Promise<CartItem[]> {
    return (
        tx
            .select()
            .from(schema.cartItem)
            .where(eq(schema.cartItem.cartId, cartId))
            // ULIDs sort by creation, so the cart reads in the order it was filled.
            .orderBy(asc(schema.cartItem.id))
    );
}

export async function countCartItems(
    tx: Executor,
    cartId: string,
): Promise<number> {
    const rows = await tx
        .select({ id: schema.cartItem.id })
        .from(schema.cartItem)
        .where(eq(schema.cartItem.cartId, cartId));

    return rows.length;
}

export async function addCartItem(
    tx: Executor,
    input: {
        cartId: string;
        productId: string;
        cycle: BillingCycle;
        currency: string;
        quantity: number;
        selections: CartSelection[];
        couponCode?: string | null;
    },
): Promise<CartItem> {
    const [row] = await tx
        .insert(schema.cartItem)
        .values({
            id: createId("cartitem"),
            cartId: input.cartId,
            productId: input.productId,
            cycle: input.cycle,
            currency: input.currency,
            quantity: input.quantity,
            selections: input.selections,
            couponCode: input.couponCode?.trim().toUpperCase() || null,
        })
        .returning();

    return row;
}

/**
 * Both ids are required: the item is only ever addressed through the cart it
 * belongs to, so a posted item id from somebody else's cart matches nothing.
 */
export async function updateCartItem(
    tx: Executor,
    cartId: string,
    itemId: string,
    patch: { quantity?: number; couponCode?: string | null },
): Promise<CartItem | null> {
    const [row] = await tx
        .update(schema.cartItem)
        .set({
            ...(patch.quantity === undefined
                ? {}
                : { quantity: patch.quantity }),
            ...(patch.couponCode === undefined
                ? {}
                : {
                      couponCode:
                          patch.couponCode?.trim().toUpperCase() || null,
                  }),
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(schema.cartItem.id, itemId),
                eq(schema.cartItem.cartId, cartId),
            ),
        )
        .returning();

    return row ?? null;
}

export async function removeCartItem(
    tx: Executor,
    cartId: string,
    itemId: string,
): Promise<void> {
    await tx
        .delete(schema.cartItem)
        .where(
            and(
                eq(schema.cartItem.id, itemId),
                eq(schema.cartItem.cartId, cartId),
            ),
        );
}

/** Marks the cart as spent and points it at what it became. */
export async function closeCart(
    tx: Executor,
    cartId: string,
    outcome:
        | { status: "ordered"; orderId: string }
        | { status: "merged"; mergedIntoCartId: string }
        | { status: "abandoned" },
): Promise<void> {
    await tx
        .update(schema.cart)
        .set({
            status: outcome.status,
            orderId: outcome.status === "ordered" ? outcome.orderId : null,
            mergedIntoCartId:
                outcome.status === "merged" ? outcome.mergedIntoCartId : null,
            updatedAt: new Date(),
        })
        .where(eq(schema.cart.id, cartId));
}

export async function touchCart(tx: Executor, cartId: string): Promise<void> {
    await tx
        .update(schema.cart)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.cart.id, cartId));
}

/**
 * Takes the cart row for update, so two requests cannot check out the same
 * cart at once. Returns null when the id is unknown.
 */
export async function lockCart(tx: Tx, cartId: string): Promise<Cart | null> {
    const [row] = await tx
        .select()
        .from(schema.cart)
        .where(eq(schema.cart.id, cartId))
        .for("update");

    return row ?? null;
}

/**
 * Moves a guest cart's items onto the account's cart and closes the guest
 * cart behind them.
 *
 * Idempotent on purpose: it is called from whatever page the customer lands
 * on after signing in, which may be rendered more than once, and the source
 * cart is only open until the first call finishes. Run inside a transaction
 * that has locked the source — `claimCartForCustomer` does.
 */
export async function moveCartItems(
    tx: Executor,
    fromCartId: string,
    toCartId: string,
): Promise<number> {
    const items = await loadCartItems(tx, fromCartId);

    if (items.length === 0) {
        return 0;
    }

    await tx
        .update(schema.cartItem)
        .set({ cartId: toCartId, updatedAt: new Date() })
        .where(
            inArray(
                schema.cartItem.id,
                items.map((item) => item.id),
            ),
        );

    return items.length;
}

/**
 * What happens the moment a guest signs in.
 *
 * With no cart of their own the guest cart simply becomes theirs — the
 * cheapest outcome, and the one that keeps the cookie pointing somewhere
 * useful. With one, the guest's items are moved onto it and the guest cart
 * is closed as `merged`, so the move is visible afterwards rather than
 * looking like items that appeared from nowhere.
 *
 * A cart that already belongs to *another* account is left alone and never
 * claimed: a shared browser must not carry one customer's basket into
 * another's account.
 */
export async function claimCartForCustomer(
    tx: Tx,
    guestCartId: string,
    customerId: string,
): Promise<{ cartId: string | null; merged: number }> {
    const guest = await lockCart(tx, guestCartId);

    if (guest?.status !== "open") {
        const own = await findOpenCartForCustomer(tx, customerId);

        return { cartId: own?.id ?? null, merged: 0 };
    }

    if (guest.customerId && guest.customerId !== customerId) {
        const own = await findOpenCartForCustomer(tx, customerId);

        return { cartId: own?.id ?? null, merged: 0 };
    }

    const own = await findOpenCartForCustomer(tx, customerId);

    if (!own) {
        await tx
            .update(schema.cart)
            .set({ customerId, updatedAt: new Date() })
            .where(eq(schema.cart.id, guest.id));

        return { cartId: guest.id, merged: 0 };
    }

    if (own.id === guest.id) {
        return { cartId: own.id, merged: 0 };
    }

    const moved = await moveCartItems(tx, guest.id, own.id);

    await closeCart(tx, guest.id, {
        status: "merged",
        mergedIntoCartId: own.id,
    });

    return { cartId: own.id, merged: moved };
}
