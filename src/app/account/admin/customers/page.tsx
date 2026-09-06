import { asc } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import { db, schema } from "@/lib/db";
import CustomerList from "./customer-list";

export default async function Page() {
    await requireAdmin();

    const customers = await db
        .select()
        .from(schema.user)
        .orderBy(asc(schema.user.email));

    return (
        <>
            <PageHeader
                title="Kunden"
                intro="Konten ansehen und Stammdaten korrigieren. E-Mail-Adresse und Rolle ändern sich hier nicht."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <CustomerList
                    customers={customers.map((entry) => ({
                        id: entry.id,
                        customerNumber: entry.customerNumber,
                        email: entry.email,
                        emailVerified: entry.emailVerified,
                        role: entry.role,
                        name: entry.name ?? "",
                        company: entry.company ?? "",
                        street: entry.street ?? "",
                        postalCode: entry.postalCode ?? "",
                        city: entry.city ?? "",
                        country: entry.country ?? "",
                        vatId: entry.vatId ?? "",
                        phone: entry.phone ?? "",
                        buyerReference: entry.buyerReference ?? "",
                    }))}
                />
            </div>
        </>
    );
}
