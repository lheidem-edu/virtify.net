import { requireSession } from "@/lib/auth-session";
import ProfileForm from "./profile-form";

export default async function Page() {
    const session = await requireSession();

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
                    user={{
                        name: session.user.name ?? "",
                        company: session.user.company ?? "",
                        street: session.user.street ?? "",
                        postalCode: session.user.postalCode ?? "",
                        city: session.user.city ?? "",
                        country: session.user.country ?? "",
                        vatId: session.user.vatId ?? "",
                        phone: session.user.phone ?? "",
                    }}
                />
            </section>
        </>
    );
}
