import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import { formatPrice } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import {
    listGroups,
    listPricing,
    listProducts,
} from "@/server/catalog/repository";
import { listModules } from "@/server/provisioning";
import { GroupRowActions, NewGroup, NewProduct } from "./catalog-forms";
import { labelFor, PRODUCT_STATUSES, PRODUCT_TYPES } from "./labels";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<
    string,
    "positive" | "warning" | "muted" | "neutral"
> = {
    draft: "muted",
    active: "positive",
    hidden: "warning",
    retired: "neutral",
};

/** The lowest recurring price a product is sold at, for the overview column. */
function cheapest(cells: { priceCents: number; cycle: string }[]) {
    const recurring = cells.filter((cell) => cell.cycle !== "onetime");
    const pool = recurring.length > 0 ? recurring : cells;

    return pool.length === 0
        ? null
        : pool.reduce((lowest, cell) =>
              cell.priceCents < lowest.priceCents ? cell : lowest,
          );
}

export default async function Page() {
    await requirePermission("catalog.read");

    const groups = await listGroups(db, { includeHidden: true });
    const products = await listProducts(db, { limit: 100 });
    const pricing = await listPricing(
        db,
        products.data.map((row) => row.id),
    );

    const groupById = new Map(groups.map((row) => [row.id, row]));
    const modules = listModules().map((entry) => ({
        value: entry.id,
        label: entry.label,
    }));

    return (
        <>
            <PageHeader
                title="Katalog"
                intro="Produktgruppen, Produkte und ihre Preise. Was hier aktiv ist, lässt sich im Shop bestellen — über dieselbe Preisfunktion, die später die Rechnung schreibt."
                action={
                    <Link
                        href="/admin/catalog/coupons"
                        className="rounded-md border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Gutscheine
                    </Link>
                }
            />

            <section className="space-y-6 border-b px-6 py-10 md:px-10 md:py-12">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium tracking-tight">
                        Gruppen
                    </h2>
                    <NewGroup />
                </div>

                {groups.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Noch keine Gruppe. Produkte brauchen eine, bevor sie
                        angelegt werden können.
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {groups.map((group, index) => (
                            <li key={group.id} className="p-4">
                                <div className="flex flex-wrap items-center justify-between gap-4">
                                    <div>
                                        <p className="text-sm">
                                            {group.name}
                                            {group.hidden ? (
                                                <span className="ml-3">
                                                    <StatusBadge
                                                        label="Ausgeblendet"
                                                        tone="muted"
                                                    />
                                                </span>
                                            ) : null}
                                        </p>
                                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                                            /products/{group.slug}
                                        </p>
                                    </div>
                                    <GroupRowActions
                                        group={{
                                            id: group.id,
                                            slug: group.slug,
                                            name: group.name,
                                            tagline: group.tagline ?? "",
                                            description:
                                                group.description ?? "",
                                            sortOrder: group.sortOrder,
                                            hidden: group.hidden,
                                        }}
                                        first={index === 0}
                                        last={index === groups.length - 1}
                                    />
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="space-y-6 px-6 py-10 md:px-10 md:py-12">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium tracking-tight">
                        Produkte
                    </h2>
                    <NewProduct
                        groups={groups.map((group) => ({
                            value: group.id,
                            label: group.name,
                        }))}
                        modules={modules}
                    />
                </div>

                {products.data.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Noch kein Produkt angelegt.
                    </p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full text-sm">
                            <thead className="border-b text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-4 py-3 font-medium">
                                        Produkt
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Gruppe
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Art
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Ab
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Status
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {products.data.map((row) => {
                                    const cells = pricing.filter(
                                        (cell) => cell.productId === row.id,
                                    );
                                    const lowest = cheapest(cells);

                                    return (
                                        <tr
                                            key={row.id}
                                            className="border-b last:border-0"
                                        >
                                            <td className="px-4 py-3">
                                                <Link
                                                    href={`/admin/catalog/${row.id}`}
                                                    className="underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white"
                                                >
                                                    {row.name}
                                                </Link>
                                                <span className="block font-mono text-xs text-muted-foreground">
                                                    {row.slug}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {groupById.get(row.groupId)
                                                    ?.name ?? "—"}
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {labelFor(
                                                    PRODUCT_TYPES,
                                                    row.type,
                                                )}
                                            </td>
                                            <td className="px-4 py-3 tabular-nums text-muted-foreground">
                                                {lowest
                                                    ? formatPrice(
                                                          lowest.priceCents,
                                                      )
                                                    : "kein Preis"}
                                            </td>
                                            <td className="px-4 py-3">
                                                <StatusBadge
                                                    label={labelFor(
                                                        PRODUCT_STATUSES,
                                                        row.status,
                                                    )}
                                                    tone={
                                                        STATUS_TONE[
                                                            row.status
                                                        ] ?? "neutral"
                                                    }
                                                />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </>
    );
}
