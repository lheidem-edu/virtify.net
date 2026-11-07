import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { db } from "@/db";
import type { Cart } from "@/db/schema";
import { getSession } from "@/server/auth/session";
import {
    CART_COOKIE_MAX_AGE_SECONDS,
    claimCartForCustomer,
    createCart,
    findCartByToken,
    findOpenCartForCustomer,
    getCart,
} from "@/server/cart/repository";
import { customerForUser } from "@/server/customers/repository";

/**
 * Which cart this request is holding.
 *
 * A guest is identified by one thing only: a 32-byte secret in an httpOnly
 * cookie, stored hashed. There is no guest id in a URL, no cart id in a form
 * field, and nothing a browser sends can name a cart it was not given the
 * secret for.
 *
 * Signing in merges rather than switches — see `claimCartForCustomer`. The
 * merge happens lazily, on whatever page is rendered next, because the login
 * runs through Better Auth in the browser and there is no server step of
 * ours to hang it on. It is idempotent and transactional, so being called
 * twice by a re-render costs a no-op.
 */

export const CART_COOKIE = "vfy_cart";

/** The account this request acts for, or null. Never redirects. */
export const optionalCustomerId = cache(async (): Promise<string | null> => {
    const session = await getSession();

    if (!session) {
        return null;
    }

    const row = await customerForUser(db, session.user.id);

    return row?.customer.id ?? null;
});

async function cookieToken(): Promise<string | null> {
    const store = await cookies();

    return store.get(CART_COOKIE)?.value ?? null;
}

async function writeCookie(token: string): Promise<void> {
    const store = await cookies();

    store.set(CART_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: CART_COOKIE_MAX_AGE_SECONDS,
    });
}

export async function clearCartCookie(): Promise<void> {
    const store = await cookies();

    store.delete(CART_COOKIE);
}

/**
 * The request's cart, without creating one.
 *
 * Safe to call while rendering: it writes no cookie. It may still *merge* a
 * guest cart into the signed-in account's, which is a write — the
 * alternative is a customer who signs in on the cart page and is shown an
 * empty one.
 */
export async function currentCart(): Promise<Cart | null> {
    const token = await cookieToken();
    const customerId = await optionalCustomerId();
    const fromCookie = token ? await findCartByToken(db, token) : null;

    if (!customerId) {
        // A cart the cookie points at but that now belongs to an account is
        // not this visitor's: somebody signed in on this browser and signed
        // out again. Their basket is not handed to the next person.
        return fromCookie?.customerId === null ? fromCookie : null;
    }

    if (fromCookie) {
        // The cookie is what this browser is holding, so it wins over any
        // other open cart the account may have. Preferring the account's
        // oldest instead would, after two requests raced to create one,
        // show the customer a different cart from the one they just filled.
        if (fromCookie.customerId === customerId) {
            return fromCookie;
        }

        if (fromCookie.customerId === null) {
            const { cartId } = await db.transaction((tx) =>
                claimCartForCustomer(tx, fromCookie.id, customerId),
            );

            if (cartId) {
                return getCart(db, cartId);
            }
        }

        // Anything else belongs to another account and is left alone.
    }

    return findOpenCartForCustomer(db, customerId);
}

/**
 * The request's cart, creating one if there is none — which writes the
 * cookie, so this may only be called from a server action or a route
 * handler. A server component that calls it throws, and deliberately: a
 * cookie written during a render is a cookie the browser never receives.
 */
export async function requireCart(): Promise<Cart> {
    const existing = await currentCart();

    if (existing) {
        return existing;
    }

    const customerId = await optionalCustomerId();
    const { cart, token } = await createCart(db, { customerId });

    await writeCookie(token);

    return cart;
}
