import Link from "next/link";
import { db } from "@/db";
import { formatPrice } from "@/lib/format";
import { CYCLE_LABEL } from "@/server/billing/pricing";
import {
    listGroups,
    listPricing,
    listProducts,
} from "@/server/catalog/repository";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Produkte",
    description: "Was virtify.net anbietet, mit Preisen.",
};

/**
 * The group overview. Deliberately thin: CLAUDE.md says the storefront is in
 * front of the panel, not the point of it, so this is a list that leads to a
 * product page and no further.
 */
export default async function Page() {
    const groups = await listGroups(db);
    const products = await listProducts(db, { limit: 100, sellableOnly: true });
    const pricing = await listPricing(
        db,
        products.data.map((row) => row.id),
    );

    const listed = products.data.filter(
        (row) =>
            row.status === "active" &&
            groups.some((group) => group.id === row.groupId),
    );

    const cheapest = (productId: string) => {
        const cells = pricing.filter((cell) => cell.productId === productId);
        const recurring = cells.filter((cell) => cell.cycle !== "onetime");
        const pool = recurring.length > 0 ? recurring : cells;

        return pool.length === 0
            ? null
            : pool.reduce((lowest, cell) =>
                  cell.priceCents < lowest.priceCents ? cell : lowest,
              );
    };

    return (
        <>
            <section className="border-b px-6 py-20 md:px-10 md:py-24">
                <h1 className="max-w-4xl text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl">
                    Produkte
                </h1>
                <p className="mt-8 max-w-2xl text-lg text-zinc-300">
                    Was sich bei uns buchen lässt, mit den Preisen, die auch auf
                    der Rechnung stehen.
                </p>
            </section>

            {listed.length === 0 ? (
                <section className="px-6 py-16 md:px-10 md:py-20">
                    <p className="text-sm text-zinc-500">
                        Zurzeit ist nichts zur Bestellung freigegeben. Instanzen
                        richten wir auf Anfrage ein.
                    </p>
                </section>
            ) : (
                groups.map((group) => {
                    const inGroup = listed.filter(
                        (row) => row.groupId === group.id,
                    );

                    if (inGroup.length === 0) {
                        return null;
                    }

                    return (
                        <section
                            key={group.id}
                            id={group.slug}
                            className="border-b px-6 py-16 last:border-0 md:px-10 md:py-20"
                        >
                            <h2 className="text-sm font-medium tracking-tight">
                                {group.name}
                            </h2>
                            {group.tagline ? (
                                <p className="mt-3 max-w-2xl text-sm text-zinc-500">
                                    {group.tagline}
                                </p>
                            ) : null}

                            <ul className="mt-8 grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-3">
                                {inGroup.map((product) => {
                                    const lowest = cheapest(product.id);

                                    return (
                                        <li
                                            key={product.id}
                                            className="bg-background p-6"
                                        >
                                            <h3 className="text-sm font-medium tracking-tight">
                                                <Link
                                                    href={`/products/${product.slug}`}
                                                    className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:decoration-white"
                                                >
                                                    {product.name}
                                                </Link>
                                            </h3>
                                            {product.tagline ? (
                                                <p className="mt-3 text-sm leading-6 text-zinc-500">
                                                    {product.tagline}
                                                </p>
                                            ) : null}
                                            <p className="mt-6 text-sm tabular-nums">
                                                {lowest ? (
                                                    <>
                                                        ab{" "}
                                                        {formatPrice(
                                                            lowest.priceCents,
                                                        )}{" "}
                                                        <span className="text-zinc-500">
                                                            {
                                                                CYCLE_LABEL[
                                                                    lowest.cycle
                                                                ]
                                                            }
                                                        </span>
                                                    </>
                                                ) : (
                                                    <span className="text-zinc-500">
                                                        Preis auf Anfrage
                                                    </span>
                                                )}
                                            </p>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    );
                })
            )}
        </>
    );
}
