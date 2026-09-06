import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { CONTRACT_STATUS_LABEL, formatPrice } from "@/lib/format";
import ContractForm from "./contract-form";

export const metadata: Metadata = {
    title: "Administration",
    robots: { index: false, follow: false },
};

export default async function Page() {
    await requireAdmin();

    const accounts = await db
        .select({
            id: schema.user.id,
            name: schema.user.name,
            email: schema.user.email,
        })
        .from(schema.user)
        .orderBy(schema.user.email);

    const contracts = await db
        .select({
            id: schema.contract.id,
            number: schema.contract.number,
            title: schema.contract.title,
            status: schema.contract.status,
            monthlyPriceCents: schema.contract.monthlyPriceCents,
            email: schema.user.email,
        })
        .from(schema.contract)
        .innerJoin(schema.user, eq(schema.contract.userId, schema.user.id))
        .orderBy(desc(schema.contract.createdAt));

    return (
        <>
            <section className="border-b px-6 py-16 md:px-10 md:py-20">
                <h1 className="text-3xl font-semibold tracking-tight">
                    Administration
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                    Verträge anlegen und Konten zuordnen.
                </p>
            </section>

            <section className="grid gap-x-12 gap-y-8 border-b px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Vertrag anlegen
                </h2>
                <ContractForm accounts={accounts} />
            </section>

            <section className="grid gap-x-12 gap-y-8 px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Verträge
                </h2>
                <div className="max-w-3xl">
                    {contracts.length === 0 ? (
                        <p className="text-sm text-zinc-500">
                            Noch keine Verträge angelegt.
                        </p>
                    ) : (
                        <ul className="border-t">
                            {contracts.map((entry) => (
                                <li key={entry.id} className="border-b py-4">
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                                        <span className="text-sm">
                                            {entry.title}
                                        </span>
                                        <span className="font-mono text-xs text-zinc-500">
                                            {formatPrice(
                                                entry.monthlyPriceCents,
                                            )}{" "}
                                            ·{" "}
                                            {
                                                CONTRACT_STATUS_LABEL[
                                                    entry.status
                                                ]
                                            }
                                        </span>
                                    </div>
                                    <p className="mt-1 font-mono text-xs break-all text-zinc-600">
                                        {entry.number} · {entry.email}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>
        </>
    );
}
