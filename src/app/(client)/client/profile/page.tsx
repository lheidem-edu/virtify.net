import { getCurrentCustomer } from "@/server/customers/current";
import ProfileForm from "./profile-form";

export default async function Page() {
    const { customer } = await getCurrentCustomer();

    return (
        <>
            <section className="border-b px-6 py-16 md:px-10 md:py-20">
                <h1 className="text-3xl font-semibold tracking-tight">
                    Stammdaten
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                    Diese Angaben verwenden wir für Verträge und Rechnungen.
                    Deine E-Mail-Adresse änderst du unter Sicherheit.
                </p>
            </section>

            <section className="px-6 py-16 md:px-10 md:py-20">
                <ProfileForm
                    customer={{
                        kind: customer.kind,
                        name: customer.name,
                        company: customer.company ?? "",
                        street: customer.street ?? "",
                        postalCode: customer.postalCode ?? "",
                        city: customer.city ?? "",
                        country: customer.country ?? "",
                        vatId: customer.vatId ?? "",
                        phone: customer.phone ?? "",
                    }}
                />
            </section>
        </>
    );
}
