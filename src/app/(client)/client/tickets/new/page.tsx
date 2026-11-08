import PageHeader from "@/components/shared/page-header";
import { db } from "@/db";
import { getCurrentCustomer } from "@/server/customers/current";
import { listDepartments } from "@/server/tickets/departments";
import NewTicketForm from "./new-ticket-form";

export default async function Page() {
    const { contact } = await getCurrentCustomer();
    const departments = await listDepartments(db, { activeOnly: true });

    return (
        <>
            <PageHeader
                title="Neues Ticket"
                intro="Beschreibe kurz, worum es geht. Du bekommst eine Bestätigung an deine Kontaktadresse; die Kennzeichnung im Betreff hält die Unterhaltung zusammen."
            />

            <div className="px-6 py-10 md:px-10 md:py-12">
                {!contact.canTickets ? (
                    <p className="text-sm text-muted-foreground">
                        Dieser Zugang darf keine Tickets eröffnen.
                    </p>
                ) : departments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Zurzeit nimmt keine Abteilung Tickets an. Schreib uns
                        solange direkt eine Mail.
                    </p>
                ) : (
                    <NewTicketForm
                        departments={departments.map((entry) => ({
                            id: entry.id,
                            label: entry.description
                                ? `${entry.name} — ${entry.description}`
                                : entry.name,
                        }))}
                        email={contact.email}
                    />
                )}
            </div>
        </>
    );
}
