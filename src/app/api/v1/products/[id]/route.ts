import { db } from "@/db";
import { authenticate } from "@/server/api/auth";
import { json, notFound } from "@/server/api/respond";
import { serializeProductDetail } from "@/server/catalog/api";
import { loadSellableProduct } from "@/server/catalog/lookup";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
    const auth = await authenticate(request, "catalog.read");

    if (!auth.ok) {
        return auth.response;
    }

    const { id } = await params;
    const detail = await loadSellableProduct(db, id);

    if (!detail) {
        return notFound();
    }

    return json(serializeProductDetail(detail));
}
