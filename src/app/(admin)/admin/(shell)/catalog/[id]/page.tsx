import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import { formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import {
    cyclesOffered,
    getProduct,
    listGroups,
    loadProductDetail,
} from "@/server/catalog/repository";
import { CATALOG_CURRENCIES } from "@/server/catalog/schema";
import { auditTrail } from "@/server/customers/repository";
import { listModules } from "@/server/provisioning";
import { toInput } from "../labels";
import {
    NewOption,
    OptionEditor,
    PricingMatrix,
    ProductEditForm,
} from "./product-forms";

export const dynamic = "force-dynamic";

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    await requirePermission("catalog.read");

    const { id } = await params;
    const product = await getProduct(db, id);

    if (!product) {
        notFound();
    }

    const detail = await loadProductDetail(db, product);

    if (!detail) {
        notFound();
    }

    const groups = await listGroups(db, { includeHidden: true });
    const trail = await auditTrail(db, product.id, 20);

    const currencies = [...CATALOG_CURRENCIES];
    // Only the cycles this product is actually sold in: an add-on's surcharge
    // has to attach to a price, and a column for a cycle with no price would
    // be a surcharge on nothing.
    const cycles = currencies.flatMap((currency) =>
        cyclesOffered(detail.pricing, currency),
    );
    const distinctCycles = [...new Set(cycles)];

    return (
        <>
            <PageHeader
                title={product.name}
                intro={product.tagline ?? undefined}
                action={
                    <Link
                        href="/admin/catalog"
                        className="rounded-md border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Zurück zum Katalog
                    </Link>
                }
            />

            {product.deletedAt ? (
                <div className="border-b bg-destructive/10 px-6 py-4 md:px-10">
                    <p className="text-sm text-destructive">
                        Dieses Produkt ist gelöscht (
                        {formatDate(product.deletedAt)}). Es wird weder im Shop
                        noch über die API ausgeliefert.
                    </p>
                </div>
            ) : null}

            <section className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Stammdaten
                </h2>
                <ProductEditForm
                    product={{
                        id: product.id,
                        groupId: product.groupId,
                        slug: product.slug,
                        name: product.name,
                        type: product.type,
                        status: product.status,
                        tagline: product.tagline ?? "",
                        description: product.description ?? "",
                        sortOrder: product.sortOrder,
                        module: product.module,
                        moduleConfig: JSON.stringify(
                            product.moduleConfig ?? {},
                            null,
                            2,
                        ),
                        maxQuantity: product.maxQuantity,
                        deleted: product.deletedAt !== null,
                    }}
                    groups={groups.map((group) => ({
                        value: group.id,
                        label: group.name,
                    }))}
                    modules={listModules().map((entry) => ({
                        value: entry.id,
                        label: entry.label,
                        description: entry.description,
                    }))}
                />
            </section>

            <section className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Preise
                </h2>
                <PricingMatrix
                    productId={product.id}
                    currencies={currencies}
                    cells={detail.pricing.map((cell) => ({
                        cycle: cell.cycle,
                        currency: cell.currency,
                        priceCents: cell.priceCents,
                        setupFeeCents: cell.setupFeeCents,
                        trialDays: cell.trialDays,
                    }))}
                />
            </section>

            <section className="space-y-6 border-b px-6 py-10 md:px-10 md:py-12">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium tracking-tight">
                        Zusatzleistungen
                    </h2>
                    <NewOption productId={product.id} />
                </div>

                {detail.options.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Keine Optionen. Ohne sie wird das Produkt genau so
                        verkauft, wie es oben steht.
                    </p>
                ) : (
                    <div className="space-y-4">
                        {detail.options.map(({ option, values }) => (
                            <OptionEditor
                                key={option.id}
                                productId={product.id}
                                option={{
                                    id: option.id,
                                    name: option.name,
                                    description: option.description ?? "",
                                    type: option.type,
                                    required: option.required,
                                    sortOrder: option.sortOrder,
                                    minQuantity: option.minQuantity,
                                    maxQuantity: option.maxQuantity,
                                }}
                                values={values.map(({ value, pricing }) => ({
                                    id: value.id,
                                    name: value.name,
                                    isDefault: value.isDefault,
                                    pricing: pricing.map((cell) => ({
                                        cycle: cell.cycle,
                                        currency: cell.currency,
                                        price: toInput(cell.priceCents),
                                        setup: toInput(cell.setupFeeCents),
                                    })),
                                }))}
                                cycles={distinctCycles}
                                currencies={currencies}
                            />
                        ))}
                    </div>
                )}
            </section>

            <section className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Protokoll
                </h2>

                {trail.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Noch keine Änderung aufgezeichnet.
                    </p>
                ) : (
                    <ul className="space-y-3 text-sm">
                        {trail.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex flex-wrap items-baseline gap-3"
                            >
                                <StatusBadge
                                    label={entry.action}
                                    tone="neutral"
                                />
                                <span className="text-muted-foreground">
                                    {entry.actorLabel ?? entry.actorType}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {formatDate(entry.createdAt)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
}
