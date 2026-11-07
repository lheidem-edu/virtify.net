import {
    type Executor,
    getProduct,
    getProductBySlug,
    loadProductDetail,
    type ProductDetail,
} from "@/server/catalog/repository";

/**
 * Finding a product the way a buyer may see it.
 *
 * Shared by the storefront and by `/api/v1/products/{id}`, because they have
 * to agree on what "not for sale" means. A draft and a retired tariff are
 * simply not there: answering 403 would confirm that the id exists, and
 * answering 200 would offer something that is not on sale.
 */
const SELLABLE = new Set(["active", "hidden"]);

/** Takes either the technical id or the slug — both appear in URLs. */
export async function findProduct(db: Executor, idOrSlug: string) {
    return idOrSlug.startsWith("product_")
        ? ((await getProduct(db, idOrSlug)) ??
              (await getProductBySlug(db, idOrSlug)))
        : ((await getProductBySlug(db, idOrSlug)) ??
              (await getProduct(db, idOrSlug)));
}

export async function loadSellableProduct(
    db: Executor,
    idOrSlug: string,
): Promise<ProductDetail | null> {
    const product = await findProduct(db, idOrSlug);

    if (!product || !SELLABLE.has(product.status)) {
        return null;
    }

    const detail = await loadProductDetail(db, product);

    // A product whose group is hidden is not listed, but it is still
    // orderable by its own link — that is what `hidden` is for.
    return detail;
}
