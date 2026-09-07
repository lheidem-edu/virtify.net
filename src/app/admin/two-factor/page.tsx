import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { requireStaff } from "@/lib/staff-session";
import PasswordForm from "./password-form";

/** The employee's own account: the password and the second factor. */
export default async function Page() {
    const session = await requireStaff();

    return (
        <>
            <PageHeader
                title="Sicherheit"
                intro="Dieser Zugang gilt nur für die Verwaltung. Ein Kundenkonto unter derselben Adresse hat ein eigenes Passwort und eine eigene Zwei-Faktor-Anmeldung."
            />

            <div className="space-y-12 px-6 py-10 md:px-10 md:py-12">
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-sm font-medium tracking-tight">
                            Zwei-Faktor-Anmeldung
                        </h2>
                        <StatusBadge label="aktiv" tone="positive" />
                    </div>
                    <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                        Beim Anmelden als {session.user.email} fragen wir
                        zusätzlich einen Code aus deiner Authenticator-App ab.
                        Sie lässt sich nicht abschalten — ohne sie bleibt die
                        Verwaltung gesperrt.
                    </p>
                </div>

                <div className="space-y-6 border-t pt-10">
                    <h2 className="text-sm font-medium tracking-tight">
                        Passwort ändern
                    </h2>
                    <PasswordForm />
                </div>
            </div>
        </>
    );
}
