import { requireSession } from "@/lib/auth-session";
import ChangeEmail from "./change-email";
import ChangePassword from "./change-password";
import TwoFactor from "./two-factor";

export default async function Page() {
    const session = await requireSession();

    return (
        <>
            <section className="border-b px-6 py-16 md:px-10 md:py-20">
                <h1 className="text-3xl font-semibold tracking-tight">
                    Sicherheit
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                    E-Mail-Adresse, Passwort und Zwei-Faktor-Authentifizierung.
                </p>
            </section>

            <section className="grid gap-x-12 gap-y-8 border-b px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    E-Mail-Adresse
                </h2>
                <ChangeEmail current={session.user.email} />
            </section>

            <section className="grid gap-x-12 gap-y-8 border-b px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Passwort
                </h2>
                <ChangePassword />
            </section>

            <section className="grid gap-x-12 gap-y-8 border-b px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Zwei-Faktor-Authentifizierung
                </h2>
                <TwoFactor enabled={session.user.twoFactorEnabled === true} />
            </section>

            <section className="grid gap-x-12 gap-y-8 px-6 py-16 md:grid-cols-[13rem_minmax(0,1fr)] md:px-10 md:py-20">
                <h2 className="self-start text-sm font-medium tracking-tight">
                    Konto löschen
                </h2>
                <p className="max-w-xl text-sm leading-7 text-zinc-400">
                    Eine Löschung nehmen wir auf Anfrage vor. Schreib uns dazu
                    aus dem Postfach deiner hinterlegten Adresse. Solange ein
                    Vertrag läuft, ist eine Löschung nicht möglich; darüber
                    hinaus bestehen handels- und steuerrechtliche
                    Aufbewahrungsfristen für Vertrags- und Rechnungsdaten.
                </p>
            </section>
        </>
    );
}
