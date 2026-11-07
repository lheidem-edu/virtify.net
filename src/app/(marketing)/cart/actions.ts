"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { quoteProductDetail } from "@/server/billing/quote";
import {
    addCartItem,
    countCartItems,
    removeCartItem,
    updateCartItem,
} from "@/server/cart/repository";
import { currentCart, requireCart } from "@/server/cart/session";
import { loadSellableProduct } from "@/server/catalog/lookup";
import { CatalogError } from "@/server/catalog/repository";
import { quoteRequestSchema } from "@/server/catalog/schema";
import { loadSettings } from "@/server/settings";

/**
 * The cart's writes.
 *
 * Every one of them re-reads the catalog and re-prices the configuration
 * before it stores anything: the browser says *what* it wants, never what
 * that costs, and a configuration the price function refuses is refused here
 * too rather than sitting in the cart until the checkout trips over it.
 */

export type CartActionResult = {
    ok: boolean;
    message?: string;
    /** How many lines the cart holds afterwards, for the header. */
    count?: number;
};

export async function addToCart(input: unknown): Promise<CartActionResult> {
    if (typeof input !== "object" || input === null) {
        return { ok: false, message: "Ungültige Anfrage." };
    }

    const { productId, ...rest } = input as Record<string, unknown>;

    if (typeof productId !== "string") {
        return { ok: false, message: "Kein Produkt angegeben." };
    }

    const parsed = quoteRequestSchema.safeParse(rest);

    if (!parsed.success) {
        return {
            ok: false,
            message:
                parsed.error.issues[0]?.message ?? "Ungültige Konfiguration.",
        };
    }

    const detail = await loadSellableProduct(db, productId);

    if (!detail) {
        return { ok: false, message: "Dieses Produkt gibt es nicht." };
    }

    try {
        // Priced before it is stored, so an impossible configuration is
        // refused while the customer is still looking at the form.
        const settings = await loadSettings();
        // The same billing anchor the cart and the checkout quote
        // with, so one figure is shown everywhere.
        await quoteProductDetail(db, detail, parsed.data, {
            anchorDay: settings.policy.billingAnchorDay,
        });
    } catch (error) {
        if (error instanceof CatalogError) {
            return { ok: false, message: error.message };
        }

        throw error;
    }

    const cart = await requireCart();

    await addCartItem(db, {
        cartId: cart.id,
        productId: detail.product.id,
        cycle: parsed.data.cycle,
        currency: parsed.data.currency,
        quantity: parsed.data.quantity,
        selections: parsed.data.options,
        couponCode: parsed.data.couponCode,
    });

    revalidatePath("/cart");

    return {
        ok: true,
        message: `„${detail.product.name}“ liegt im Warenkorb.`,
        count: await countCartItems(db, cart.id),
    };
}

/**
 * The item is addressed through the cart this request holds, never by id
 * alone: an id from somebody else's cart matches no row.
 */
export async function setCartItemQuantity(
    itemId: string,
    quantity: number,
): Promise<CartActionResult> {
    const cart = await currentCart();

    if (!cart) {
        return { ok: false, message: "Der Warenkorb ist leer." };
    }

    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
        return { ok: false, message: "Ungültige Menge." };
    }

    const row = await updateCartItem(db, cart.id, itemId, { quantity });

    revalidatePath("/cart");

    return row
        ? { ok: true }
        : { ok: false, message: "Diese Position gibt es nicht." };
}

export async function setCartItemCoupon(
    itemId: string,
    couponCode: string,
): Promise<CartActionResult> {
    const cart = await currentCart();

    if (!cart) {
        return { ok: false, message: "Der Warenkorb ist leer." };
    }

    const row = await updateCartItem(db, cart.id, itemId, {
        couponCode: couponCode.slice(0, 40),
    });

    revalidatePath("/cart");

    return row
        ? { ok: true }
        : { ok: false, message: "Diese Position gibt es nicht." };
}

export async function removeFromCart(
    itemId: string,
): Promise<CartActionResult> {
    const cart = await currentCart();

    if (!cart) {
        return { ok: false, message: "Der Warenkorb ist leer." };
    }

    await removeCartItem(db, cart.id, itemId);
    revalidatePath("/cart");

    return { ok: true, count: await countCartItems(db, cart.id) };
}
