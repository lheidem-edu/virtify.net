import { eq } from "drizzle-orm";
import Link from "next/link";
import { requireSession } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { CONTRACT_STATUS_LABEL, formatDate, formatPrice } from "@/lib/format";

const linkClass =
    "text-white underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white";

export default async function Page() {
    const session = await requireSession();

    const contracts = await db
        .select()
        .from(schema.contract)
        .where(eq(schema.contract.userId, session.user.id))
        .orderBy(schema.contract.createdAt);

    const user = session.user;
    const addressMissing = !user.street || !user.postalCode || !user.city;

    return (
        <>
            <section className="border-b px-6 py-16 md:px-10 md:py-20">
                <h1 className="text-3xl font-semibold tracking-tight">
                    Übersicht
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                    Hier siehst du deine Verträge und die bei uns hinterlegten
                    Stammdaten.
                </p>
            </section>

            <section className="grid gap-x-12 gap-y-8 border-b px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Verträge
                </h2>

                <div className="max-w-3xl">
                    {contracts.length === 0 ? (
                        <p className="text-sm leading-7 text-zinc-400">
                            Für dein Konto ist derzeit kein Vertrag hinterlegt.
                            Sobald ein Vertrag zustande kommt, erscheint er
                            hier.
                        </p>
                    ) : (
                        <ul className="border-t">
                            {contracts.map((contract) => (
                                <li key={contract.id} className="border-b py-6">
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                                        <h3 className="text-sm font-medium tracking-tight">
                                            {contract.title}
                                        </h3>
                                        <p className="font-mono text-xs text-zinc-500">
                                            {contract.number}
                                        </p>
                                    </div>

                                    <dl className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
                                        {[
                                            {
                                                label: "Status",
                                                value: CONTRACT_STATUS_LABEL[
                                                    contract.status
                                                ],
                                            },
                                            {
                                                label: "Monatliche Vergütung",
                                                value: formatPrice(
                                                    contract.monthlyPriceCents,
                                                ),
                                            },
                                            {
                                                label: "Service-Readiness",
                                                value: formatDate(
                                                    contract.serviceReadyAt,
                                                ),
                                            },
                                            {
                                                label: "Grundlaufzeit",
                                                value: `${contract.minimumTermMonths} Monate`,
                                            },
                                            ...(contract.terminatedTo
                                                ? [
                                                      {
                                                          label: "Gekündigt zum",
                                                          value: formatDate(
                                                              contract.terminatedTo,
                                                          ),
                                                      },
                                                  ]
                                                : []),
                                        ].map((row) => (
                                            <div
                                                key={row.label}
                                                className="flex gap-4"
                                            >
                                                <dt className="w-44 shrink-0 text-sm text-zinc-500">
                                                    {row.label}
                                                </dt>
                                                <dd className="font-mono text-sm text-zinc-200">
                                                    {row.value}
                                                </dd>
                                            </div>
                                        ))}
                                    </dl>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>

            <section className="grid gap-x-12 gap-y-8 px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Stammdaten
                </h2>

                <div className="max-w-2xl">
                    {addressMissing ? (
                        <p className="mb-8 rounded-lg border p-4 text-sm leading-6 text-zinc-400">
                            Deine Anschrift ist noch nicht vollständig. Wir
                            brauchen sie, sobald ein Vertrag zustande kommt.{" "}
                            <Link
                                href="/customer/profile"
                                className={linkClass}
                            >
                                Jetzt ergänzen
                            </Link>
                        </p>
                    ) : null}

                    <dl className="border-t">
                        {[
                            { label: "Name", value: user.name },
                            { label: "E-Mail", value: user.email },
                            { label: "Firma", value: user.company },
                            { label: "Straße", value: user.street },
                            {
                                label: "PLZ und Ort",
                                value: [user.postalCode, user.city]
                                    .filter(Boolean)
                                    .join(" "),
                            },
                            { label: "Land", value: user.country },
                            { label: "USt-IdNr.", value: user.vatId },
                            { label: "Telefon", value: user.phone },
                        ].map((row) => (
                            <div
                                key={row.label}
                                className="flex flex-col gap-1 border-b py-3 sm:flex-row sm:gap-8"
                            >
                                <dt className="text-sm text-zinc-500 sm:w-44 sm:shrink-0">
                                    {row.label}
                                </dt>
                                <dd className="font-mono text-sm text-zinc-200">
                                    {row.value || "—"}
                                </dd>
                            </div>
                        ))}
                    </dl>

                    <p className="mt-6 text-sm text-zinc-500">
                        <Link href="/customer/profile" className={linkClass}>
                            Stammdaten bearbeiten
                        </Link>
                    </p>
                </div>
            </section>
        </>
    );
}
