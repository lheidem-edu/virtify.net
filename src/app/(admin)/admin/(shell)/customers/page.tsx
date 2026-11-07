import Link from "next/link";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { Input } from "@/components/ui/input";
import { db } from "@/db";
import { formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listCustomers } from "@/server/customers/repository";
import { listStoredMethods } from "@/server/documents/repository";
import NewCustomer from "./new-customer";

export const dynamic = "force-dynamic";

const STATUS: Record<
    string,
    { label: string; tone: "positive" | "warning" | "muted" }
> = {
    active: { label: "Aktiv", tone: "positive" },
    suspended: { label: "Gesperrt", tone: "warning" },
    closed: { label: "Beendet", tone: "muted" },
};

const FILTERS = [
    { value: "", label: "Alle" },
    { value: "active", label: "Aktiv" },
    { value: "suspended", label: "Gesperrt" },
    { value: "closed", label: "Beendet" },
];

type Query = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
}

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<Query>;
}) {
    await requirePermission("customers.read");

    const query = await searchParams;
    const term = single(query.q) ?? "";
    const status = single(query.status) ?? "";
    const cursor = single(query.cursor) ?? null;

    const page = await listCustomers(db, {
        cursor,
        query: term || null,
        status: (status || null) as "active" | "suspended" | "closed" | null,
    });

    // One query for every account rather than one per row.
    const methods = await listStoredMethods();

    const link = (params: Record<string, string>) => {
        const next = new URLSearchParams();

        if (term) next.set("q", term);
        if (status) next.set("status", status);

        for (const [key, value] of Object.entries(params)) {
            if (value) next.set(key, value);
            else next.delete(key);
        }

        return `/admin/customers?${next.toString()}`;
    };

    return (
        <>
            <PageHeader
                title="Kunden"
                intro="Kundenkonten ansehen und Stammdaten korrigieren. Die E-Mail-Adresse ändert nur der Kunde selbst."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Konto anlegen
                </h2>
                <NewCustomer />
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <form
                    className="mb-8 flex flex-wrap items-end gap-4"
                    action="/admin/customers"
                >
                    <div className="w-full max-w-sm space-y-2">
                        <label
                            htmlFor="q"
                            className="text-sm text-muted-foreground"
                        >
                            Suche
                        </label>
                        <Input
                            id="q"
                            name="q"
                            defaultValue={term}
                            placeholder="Kundennummer, Name, Firma oder E-Mail"
                        />
                    </div>
                    <div className="flex gap-2">
                        {FILTERS.map((filter) => (
                            <Link
                                key={filter.value || "all"}
                                href={link({
                                    status: filter.value,
                                    cursor: "",
                                })}
                                className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                                    status === filter.value
                                        ? "border-ring text-foreground"
                                        : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {filter.label}
                            </Link>
                        ))}
                    </div>
                </form>

                {page.data.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Keine Konten gefunden.
                    </p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full text-sm">
                            <thead className="border-b text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-4 py-3 font-medium">
                                        Nr.
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Konto
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Ort
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Zahlungsmittel
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Status
                                    </th>
                                    <th className="px-4 py-3 font-medium">
                                        Angelegt
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {page.data.map((row) => {
                                    const method = methods.get(row.id);
                                    const badge =
                                        STATUS[row.status] ?? STATUS.active;

                                    return (
                                        <tr
                                            key={row.id}
                                            className="border-b last:border-0"
                                        >
                                            <td className="px-4 py-3 tabular-nums text-muted-foreground">
                                                {row.customerNumber}
                                            </td>
                                            <td className="px-4 py-3">
                                                <Link
                                                    href={`/admin/customers/${row.id}`}
                                                    className="underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white"
                                                >
                                                    {row.company || row.name}
                                                </Link>
                                                {row.company ? (
                                                    <span className="block text-xs text-muted-foreground">
                                                        {row.name}
                                                    </span>
                                                ) : null}
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {[row.postalCode, row.city]
                                                    .filter(Boolean)
                                                    .join(" ") || "—"}
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {method
                                                    ? method.label
                                                    : "Überweisung"}
                                            </td>
                                            <td className="px-4 py-3">
                                                <StatusBadge
                                                    label={badge.label}
                                                    tone={badge.tone}
                                                />
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {formatDate(row.createdAt)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                {page.has_more && page.next_cursor ? (
                    <div className="mt-6">
                        <Link
                            href={link({ cursor: page.next_cursor })}
                            className="rounded-md border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                        >
                            Weitere Konten
                        </Link>
                    </div>
                ) : null}

                {cursor ? (
                    <div className="mt-6">
                        <Link
                            href={link({ cursor: "" })}
                            className="text-xs text-muted-foreground underline underline-offset-4"
                        >
                            Zurück zum Anfang
                        </Link>
                    </div>
                ) : null}
            </div>
        </>
    );
}
