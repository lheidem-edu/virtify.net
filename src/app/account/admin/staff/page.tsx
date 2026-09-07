import { asc, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { db, schema } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { InviteForm, RemoveAction, ResendAction } from "./staff-actions";

export default async function Page() {
    const session = await requireAdmin();

    const staff = await db
        .select({
            id: schema.user.id,
            name: schema.user.name,
            email: schema.user.email,
            twoFactorEnabled: schema.user.twoFactorEnabled,
            createdAt: schema.user.createdAt,
        })
        .from(schema.user)
        .where(eq(schema.user.role, "admin"))
        .orderBy(asc(schema.user.email));

    return (
        <>
            <PageHeader
                title="Mitarbeiter"
                intro="Zugänge zur Verwaltung. Ein Mitarbeiterkonto ist kein Kundenkonto: es hat keine Kundennummer, keine Stammdaten und bekommt keine Rechnungen."
            />

            <div className="space-y-12 px-6 py-10 md:px-10 md:py-12">
                <div className="space-y-4">
                    {staff.map((entry) => (
                        <div
                            key={entry.id}
                            className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
                        >
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">
                                        {entry.name}
                                    </span>
                                    {entry.id === session.user.id ? (
                                        <StatusBadge label="Du" tone="muted" />
                                    ) : null}
                                    <StatusBadge
                                        label={
                                            entry.twoFactorEnabled
                                                ? "2FA aktiv"
                                                : "ohne 2FA"
                                        }
                                        tone={
                                            entry.twoFactorEnabled
                                                ? "positive"
                                                : "warning"
                                        }
                                    />
                                </div>
                                <p className="mt-1 truncate text-sm text-muted-foreground">
                                    {entry.email} · angelegt am{" "}
                                    {formatDate(entry.createdAt)}
                                </p>
                            </div>

                            <div className="flex items-center gap-2">
                                <ResendAction userId={entry.id} />
                                {entry.id === session.user.id ? null : (
                                    <RemoveAction
                                        userId={entry.id}
                                        email={entry.email}
                                    />
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="space-y-6 border-t pt-10">
                    <div>
                        <h2 className="text-sm font-medium tracking-tight">
                            Zugang einladen
                        </h2>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                            Der Zugang wird sofort angelegt, hat aber kein
                            Passwort. Die Einladung an die angegebene Adresse
                            ist der einzige Weg hinein — wer sie öffnet, vergibt
                            das Passwort selbst.
                        </p>
                    </div>
                    <InviteForm />
                </div>
            </div>
        </>
    );
}
