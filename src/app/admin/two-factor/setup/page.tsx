import { redirect } from "next/navigation";
import AuthShell from "@/lib/components/account/auth-shell";
import { requireStaffSession } from "@/lib/staff-session";
import SetupForm from "./setup-form";

/**
 * The gate every employee passes once. A staff session reaches every
 * customer's data, so the account is not usable until it is protected —
 * requireStaff() sends anyone without two-factor here, and nowhere else.
 */
export default async function Page() {
    const session = await requireStaffSession();

    if (session.user.twoFactorEnabled) {
        redirect("/admin");
    }

    return (
        <AuthShell
            title="Zwei-Faktor-Anmeldung einrichten"
            intro="Der Zugang zur Verwaltung sieht die Daten aller Kunden. Ohne zweiten Faktor bleibt er gesperrt."
        >
            <SetupForm />
        </AuthShell>
    );
}
