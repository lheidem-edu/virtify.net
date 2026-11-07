import { db } from "@/db";
import { authenticate } from "@/server/api/auth";
import {
    invalid,
    json,
    malformed,
    notFound,
    problem,
} from "@/server/api/respond";
import { quoteProductDetail } from "@/server/billing/quote";
import {
    quoteBodySchema,
    quoteFromWire,
    serializeQuote,
} from "@/server/catalog/api";
import { loadSellableProduct } from "@/server/catalog/lookup";
import { CatalogError } from "@/server/catalog/repository";
import { quoteRequestSchema } from "@/server/catalog/schema";
import { loadSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * A POST that stores nothing. It is a POST because the request carries a
 * body — the chosen options can be longer than a query string should be —
 * not because it changes anything: a coupon is checked here, never redeemed.
 */
export async function POST(request: Request, { params }: Params) {
    const auth = await authenticate(request, "catalog.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;
    const detail = await loadSellableProduct(db, id);

    if (!detail) {
        return notFound();
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    const wire = quoteBodySchema.safeParse(body);

    if (!wire.success) {
        return invalid(wire.error);
    }

    const parsed = quoteRequestSchema.safeParse(quoteFromWire(wire.data));

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    try {
        const settings = await loadSettings();
        // The same billing anchor the cart and the checkout quote
        // with, so one figure is shown everywhere.
        const { quote } = await quoteProductDetail(db, detail, parsed.data, {
            anchorDay: settings.policy.billingAnchorDay,
        });

        return json(serializeQuote(quote));
    } catch (error) {
        // A cycle that is not offered, an option that is not this product's,
        // a quantity out of bounds: the request was well-formed and said
        // something that is not on sale.
        if (error instanceof CatalogError) {
            return problem(422, "Eingabe ungültig", error.message);
        }

        throw error;
    }
}
