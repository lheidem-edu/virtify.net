import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { CYCLE_LABEL } from "@/server/billing/pricing";
import { quoteProductDetail } from "@/server/billing/quote";
import { serializeQuote } from "@/server/catalog/api";
import { loadSellableProduct } from "@/server/catalog/lookup";
import { cyclesOffered } from "@/server/catalog/repository";
import { loadSettings } from "@/server/settings";
import Configurator, { type OptionView } from "./configurator";

export const dynamic = "force-dynamic";

export async function generateMetadata({
    params,
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const detail = await loadSellableProduct(db, slug);

    return detail
        ? {
              title: detail.product.name,
              description: detail.product.tagline ?? undefined,
          }
        : { title: "Produkt" };
}

const CURRENCY = "EUR";

export default async function Page({
    params,
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const detail = await loadSellableProduct(db, slug);

    if (!detail) {
        notFound();
    }

    const cycles = cyclesOffered(detail.pricing, CURRENCY);

    if (cycles.length === 0) {
        notFound();
    }

    const options: OptionView[] = detail.options.map(({ option, values }) => ({
        id: option.id,
        name: option.name,
        description: option.description,
        type: option.type,
        required: option.required,
        minQuantity: option.minQuantity,
        maxQuantity: option.maxQuantity,
        values: values.map(({ value }) => ({
            id: value.id,
            name: value.name,
            isDefault: value.isDefault,
        })),
    }));

    // The first price is rendered on the server, so the page arrives with a
    // total rather than filling one in after it loads — and it is produced by
    // the same function the configurator will call for every change after.
    const preselected = detail.options.flatMap(({ option, values }) => {
        const preferred =
            values.find((entry) => entry.value.isDefault) ?? values[0];

        if (!preferred) {
            return [];
        }

        if (option.type === "select") {
            return [
                {
                    optionId: option.id,
                    valueId: preferred.value.id,
                    quantity: 1,
                },
            ];
        }

        return option.required
            ? [
                  {
                      optionId: option.id,
                      valueId: preferred.value.id,
                      quantity:
                          option.type === "quantity"
                              ? Math.max(1, option.minQuantity)
                              : 1,
                  },
              ]
            : [];
    });

    // The billing anchor is part of what this costs today, so the
    // configurator quotes with it — the same call the cart, the checkout and
    // the first invoice make.
    const settings = await loadSettings();

    const { quote } = await quoteProductDetail(
        db,
        detail,
        {
            cycle: cycles[0],
            currency: CURRENCY,
            quantity: 1,
            options: preselected,
            couponCode: null,
        },
        { anchorDay: settings.policy.billingAnchorDay },
    );

    return (
        <>
            <section className="border-b px-6 py-16 md:px-10 md:py-20">
                <p className="text-xs text-zinc-600">
                    <Link
                        href={`/products#${detail.group.slug}`}
                        className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                    >
                        {detail.group.name}
                    </Link>
                </p>
                <h1 className="mt-6 max-w-4xl text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-4xl">
                    {detail.product.name}
                </h1>
                {detail.product.tagline ? (
                    <p className="mt-6 max-w-2xl text-lg text-zinc-300">
                        {detail.product.tagline}
                    </p>
                ) : null}
                {detail.product.description ? (
                    <p className="mt-4 max-w-2xl leading-7 text-zinc-500">
                        {detail.product.description}
                    </p>
                ) : null}
            </section>

            <section className="px-6 py-12 md:px-10 md:py-16">
                <Configurator
                    productId={detail.product.id}
                    currency={CURRENCY}
                    cycles={cycles.map((cycle) => ({
                        value: cycle,
                        label: CYCLE_LABEL[cycle],
                    }))}
                    options={options}
                    maxQuantity={detail.product.maxQuantity}
                    initial={{ ok: true, quote: serializeQuote(quote) }}
                />
            </section>
        </>
    );
}
