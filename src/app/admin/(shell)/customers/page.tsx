import { asc } from "drizzle-orm";
import PageHeader from "@/lib/components/account/page-header";
import { db, schema } from "@/lib/db";
import { listStoredMethods } from "@/lib/documents/repository";
import { requireStaff } from "@/lib/staff-session";
import CustomerList from "./customer-list";

export default async function Page() {
    await requireStaff();

    const customers = await db
        .select()
        .from(schema.user)
        .orderBy(asc(schema.user.email));

    // One query for every account rather than one per row.
    const methods = await listStoredMethods();

    return (
        <>
            <PageHeader
                title="Kunden"
                intro="Kundenkonten ansehen und Stammdaten korrigieren. Die E-Mail-Adresse ändert nur der Kunde selbst."
            />
            <div className="px-6 py-10 md:px-10 md:py-12">
                <CustomerList
                    customers={customers.map((entry) => {
                        const method = methods.get(entry.id);

                        return {
                            id: entry.id,
                            payment: method
                                ? {
                                      provider: method.provider,
                                      label: method.label,
                                      since: method.createdAt,
                                  }
                                : null,
                            customerNumber: entry.customerNumber,
                            email: entry.email,
                            emailVerified: entry.emailVerified,
                            name: entry.name ?? "",
                            company: entry.company ?? "",
                            street: entry.street ?? "",
                            postalCode: entry.postalCode ?? "",
                            city: entry.city ?? "",
                            country: entry.country ?? "",
                            vatId: entry.vatId ?? "",
                            phone: entry.phone ?? "",
                            buyerReference: entry.buyerReference ?? "",
                        };
                    })}
                />
            </div>
        </>
    );
}
