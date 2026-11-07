import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db } from "@/db";
import { formatDate, formatPrice } from "@/lib/format";
import { requirePermission } from "@/server/auth/staff-session";
import { listInvoices } from "@/server/billing/invoices/repository";
import {
    auditTrail,
    getCustomer,
    listContacts,
} from "@/server/customers/repository";
import {
    listContracts,
    listOffers,
    loadStoredMethodsFor,
} from "@/server/documents/repository";
import { saveCustomer } from "../actions";
import CustomerForm from "../customer-form";

export const dynamic = "force-dynamic";

const TABS = [
    { id: "overview", label: "Übersicht" },
    { id: "contacts", label: "Kontakte" },
    { id: "contracts", label: "Verträge" },
    { id: "invoices", label: "Rechnungen" },
    { id: "transactions", label: "Zahlungen" },
    { id: "tickets", label: "Tickets" },
    { id: "log", label: "Protokoll" },
] as const;

type Tab = (typeof TABS)[number]["id"];

const ACTOR: Record<string, string> = {
    staff: "Mitarbeiter",
    customer: "Kunde",
    api: "API-Schlüssel",
    system: "System",
};

function Empty({ children }: { children: React.ReactNode }) {
    return <p className="text-sm text-muted-foreground">{children}</p>;
}

export default async function Page({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requirePermission("customers.read");

    const { id } = await params;
    const query = await searchParams;
    const raw = Array.isArray(query.tab) ? query.tab[0] : query.tab;
    const tab = (TABS.find((entry) => entry.id === raw)?.id ??
        "overview") as Tab;

    const customer = await getCustomer(db, id);

    if (!customer) {
        notFound();
    }

    const [contacts, contracts, invoices, offers, methods, log] =
        await Promise.all([
            listContacts(db, id),
            listContracts(id, false),
            listInvoices(id, false),
            listOffers(id, false),
            loadStoredMethodsFor(id),
            auditTrail(db, id),
        ]);

    return (
        <>
            <PageHeader
                title={customer.company || customer.name}
                intro={`Kundennummer ${customer.customerNumber} · angelegt am ${formatDate(customer.createdAt)}`}
            />

            <div className="border-b px-6 md:px-10">
                <nav className="-mb-px flex flex-wrap gap-6">
                    {TABS.map((entry) => (
                        <Link
                            key={entry.id}
                            href={`/admin/customers/${id}?tab=${entry.id}`}
                            className={`border-b-2 pb-3 pt-4 text-sm transition-colors ${
                                tab === entry.id
                                    ? "border-foreground text-foreground"
                                    : "border-transparent text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {entry.label}
                        </Link>
                    ))}
                </nav>
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                {tab === "overview" ? (
                    <CustomerForm
                        action={saveCustomer}
                        submitLabel="Stammdaten speichern"
                        customer={{
                            id: customer.id,
                            kind: customer.kind,
                            name: customer.name,
                            company: customer.company ?? "",
                            street: customer.street ?? "",
                            postalCode: customer.postalCode ?? "",
                            city: customer.city ?? "",
                            country: customer.country ?? "",
                            vatId: customer.vatId ?? "",
                            phone: customer.phone ?? "",
                            buyerReference: customer.buyerReference ?? "",
                            language: customer.language,
                            status: customer.status,
                            notes: customer.notes ?? "",
                        }}
                    />
                ) : null}

                {tab === "contacts" ? (
                    contacts.length === 0 ? (
                        <Empty>
                            Für dieses Konto ist kein Zugang hinterlegt. Es wird
                            von der Verwaltung geführt.
                        </Empty>
                    ) : (
                        <ul className="space-y-4">
                            {contacts.map((contact) => (
                                <li
                                    key={contact.id}
                                    className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm"
                                >
                                    <span>{contact.name}</span>
                                    <span className="text-muted-foreground">
                                        {contact.email}
                                    </span>
                                    <StatusBadge
                                        label={
                                            contact.role === "owner"
                                                ? "Inhaber"
                                                : "Kontakt"
                                        }
                                        tone={
                                            contact.role === "owner"
                                                ? "positive"
                                                : "neutral"
                                        }
                                    />
                                    {contact.emailVerified ? null : (
                                        <StatusBadge
                                            label="E-Mail unbestätigt"
                                            tone="warning"
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}

                {tab === "contracts" ? (
                    contracts.length === 0 ? (
                        <Empty>Keine Verträge.</Empty>
                    ) : (
                        <ul className="space-y-3 text-sm">
                            {contracts.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                                >
                                    <Link
                                        href={`/admin/contracts/${entry.id}`}
                                        className="underline decoration-zinc-600 underline-offset-4"
                                    >
                                        {entry.title}
                                    </Link>
                                    <span className="text-muted-foreground">
                                        {formatPrice(entry.monthlyPriceCents)} /
                                        Monat
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}

                {tab === "invoices" ? (
                    invoices.length === 0 ? (
                        <Empty>Keine Rechnungen.</Empty>
                    ) : (
                        <ul className="space-y-3 text-sm">
                            {invoices.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                                >
                                    <Link
                                        href={`/admin/invoices/${entry.id}`}
                                        className="underline decoration-zinc-600 underline-offset-4"
                                    >
                                        {entry.number ?? "Entwurf"}
                                    </Link>
                                    <span className="text-muted-foreground">
                                        {formatPrice(entry.amount)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}

                {tab === "transactions" ? (
                    methods.length === 0 ? (
                        <Empty>
                            Kein Zahlungsmittel hinterlegt — Rechnungen werden
                            überwiesen. Die Zahlungsliste kommt mit Phase 5.
                        </Empty>
                    ) : (
                        <ul className="space-y-3 text-sm">
                            {methods.map((method) => (
                                <li
                                    key={method.id}
                                    className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
                                >
                                    <span>{method.label}</span>
                                    <span className="text-muted-foreground">
                                        seit {formatDate(method.createdAt)}
                                    </span>
                                    {method.revokedAt ? (
                                        <StatusBadge
                                            label="Widerrufen"
                                            tone="muted"
                                        />
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}

                {tab === "tickets" ? (
                    <Empty>
                        Tickets kommen mit Phase 7, wenn die Mailanbindung
                        steht.
                    </Empty>
                ) : null}

                {tab === "log" ? (
                    log.length === 0 ? (
                        <Empty>Noch keine Änderung protokolliert.</Empty>
                    ) : (
                        <ul className="space-y-3 text-sm">
                            {log.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="rounded-lg border p-4"
                                >
                                    <div className="flex flex-wrap items-center gap-3">
                                        <span className="font-medium">
                                            {entry.action}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {ACTOR[entry.actorType] ??
                                                entry.actorType}
                                            {entry.actorLabel
                                                ? ` · ${entry.actorLabel}`
                                                : ""}
                                            {" · "}
                                            {formatDate(entry.createdAt)}
                                        </span>
                                    </div>
                                    {entry.after ? (
                                        <pre className="mt-3 overflow-x-auto text-xs text-muted-foreground">
                                            {JSON.stringify(
                                                {
                                                    vorher: entry.before,
                                                    nachher: entry.after,
                                                },
                                                null,
                                                2,
                                            )}
                                        </pre>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}

                {offers.length > 0 && tab === "contracts" ? (
                    <p className="mt-6 text-xs text-muted-foreground">
                        {offers.length} Angebot(e) zu diesem Konto.
                    </p>
                ) : null}
            </div>
        </>
    );
}
