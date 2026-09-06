import { FileSignature, FileText, Receipt } from "lucide-react";
import Link from "next/link";
import { requireSession } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import {
    listContracts,
    listInvoices,
    listOffers,
} from "@/lib/documents/repository";

const CARD =
    "flex flex-col gap-3 rounded-lg border p-6 transition-colors hover:border-ring";

export default async function Page() {
    const session = await requireSession();
    const userId = session.user.id;

    const [contracts, offers, invoices] = await Promise.all([
        listContracts(userId, false),
        listOffers(userId, false),
        listInvoices(userId, false),
    ]);

    const openOffers = offers.filter((entry) => entry.status === "sent");
    const unpaid = invoices.filter((entry) => entry.status === "issued");
    const activeContracts = contracts.filter(
        (entry) => entry.status === "active" || entry.status === "provisioning",
    );

    const user = session.user;
    const addressMissing = !user.street || !user.postalCode || !user.city;

    const cards = [
        {
            href: "/account/contracts",
            icon: FileText,
            label: "Verträge",
            value: `${activeContracts.length} aktiv`,
            hint: `${contracts.length} insgesamt`,
        },
        {
            href: "/account/offers",
            icon: FileSignature,
            label: "Angebote",
            value:
                openOffers.length > 0
                    ? `${openOffers.length} offen`
                    : "Keine offenen",
            hint: "Mit der Annahme kommt der Vertrag zustande",
        },
        {
            href: "/account/invoices",
            icon: Receipt,
            label: "Rechnungen",
            value:
                unpaid.length > 0 ? `${unpaid.length} offen` : "Nichts offen",
            hint: `${invoices.filter((e) => e.status !== "draft").length} insgesamt`,
        },
    ];

    return (
        <>
            <PageHeader
                title="Übersicht"
                intro={`Willkommen zurück${user.name ? `, ${user.name}` : ""}.`}
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {addressMissing ? (
                    <p className="mb-8 max-w-3xl rounded-lg border p-4 text-sm leading-6 text-muted-foreground">
                        Deine Anschrift ist noch nicht vollständig. Wir brauchen
                        sie, sobald ein Vertrag zustande kommt oder eine
                        Rechnung gestellt wird.{" "}
                        <Link
                            href="/account/profile"
                            className="text-foreground underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white"
                        >
                            Jetzt ergänzen
                        </Link>
                    </p>
                ) : null}

                <div className="grid max-w-4xl gap-4 sm:grid-cols-3">
                    {cards.map((card) => (
                        <Link key={card.href} href={card.href} className={CARD}>
                            <card.icon className="size-4 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">
                                {card.label}
                            </span>
                            <span className="text-lg font-medium tracking-tight">
                                {card.value}
                            </span>
                            <span className="text-xs text-zinc-600">
                                {card.hint}
                            </span>
                        </Link>
                    ))}
                </div>
            </div>
        </>
    );
}
