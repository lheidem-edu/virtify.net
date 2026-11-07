"use server";

import { db } from "@/db";
import { quoteProductDetail } from "@/server/billing/quote";
import { serializeQuote } from "@/server/catalog/api";
import { loadSellableProduct } from "@/server/catalog/lookup";
import { CatalogError } from "@/server/catalog/repository";
import { quoteRequestSchema } from "@/server/catalog/schema";
import { loadSettings } from "@/server/settings";

/**
 * The storefront's live price.
 *
 * It calls exactly what `POST /api/v1/products/{id}/quote` and the checkout
 * of Phase 4 call, so a price the customer reads here cannot differ from the
 * one they are charged. The browser is told the total; it never computes it.
 */
export type QuoteView =
    | { ok: true; quote: ReturnType<typeof serializeQuote> }
    | { ok: false; message: string };

export async function requestQuote(input: unknown): Promise<QuoteView> {
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

    // The same filter the API uses: a draft or a retired product is simply
    // not there, whatever id the browser sends.
    const detail = await loadSellableProduct(db, productId);

    if (!detail) {
        return { ok: false, message: "Dieses Produkt gibt es nicht." };
    }

    try {
        const settings = await loadSettings();
        // The same billing anchor the cart and the checkout quote
        // with, so one figure is shown everywhere.
        const { quote } = await quoteProductDetail(db, detail, parsed.data, {
            anchorDay: settings.policy.billingAnchorDay,
        });

        return { ok: true, quote: serializeQuote(quote) };
    } catch (error) {
        if (error instanceof CatalogError) {
            return { ok: false, message: error.message };
        }

        throw error;
    }
}
