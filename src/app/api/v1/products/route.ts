import { db } from "@/db";
import { authenticate } from "@/server/api/auth";
import { invalid, json } from "@/server/api/respond";
import { productListQuerySchema, serializeProduct } from "@/server/catalog/api";
import {
    getGroupBySlug,
    listGroups,
    listPricing,
    listProducts,
} from "@/server/catalog/repository";

export const dynamic = "force-dynamic";

/**
 * The catalog is what every order starts from, so a customer's key may read
 * it. What it must not see is a product that is not for sale: drafts and
 * retired tariffs are filtered here, not by the caller remembering to.
 */
export async function GET(request: Request) {
    const auth = await authenticate(request, "catalog.read");

    if (!auth.ok) {
        return auth.response;
    }

    const query = productListQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
    );

    if (!query.success) {
        return invalid(query.error);
    }

    // `group` takes an id or a slug, because a caller reading the storefront
    // has the slug and a caller reading this API has the id.
    let groupId = query.data.group ?? null;

    if (groupId && !groupId.startsWith("productgroup_")) {
        groupId = (await getGroupBySlug(db, groupId))?.id ?? "__none__";
    }

    const page = await listProducts(db, {
        cursor: query.data.cursor,
        limit: query.data.limit,
        query: query.data.q,
        groupId,
        type: query.data.type ?? null,
        sellableOnly: true,
    });

    const groups = new Map(
        (await listGroups(db, { includeHidden: true })).map((row) => [
            row.id,
            row,
        ]),
    );
    const pricing = await listPricing(
        db,
        page.data.map((row) => row.id),
    );

    return json({
        data: page.data.flatMap((row) => {
            const group = groups.get(row.groupId);

            return group
                ? [
                      serializeProduct(
                          row,
                          group,
                          pricing.filter((cell) => cell.productId === row.id),
                      ),
                  ]
                : [];
        }),
        next_cursor: page.next_cursor,
        has_more: page.has_more,
    });
}
