import { operator } from "@/lib/site";
import { requireSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * A login with no billing account behind it. Registration creates both, so
 * this should never be reached — it exists so that the one case where it is
 * says something useful instead of throwing.
 */
export default async function Page() {
    await requireSession();

    return (
        <div className="px-6 py-16 md:px-10 md:py-20">
            <h1 className="text-3xl font-semibold tracking-tight">
                Zu diesem Zugang gehört noch kein Kundenkonto
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                Deine Anmeldung hat geklappt, aber wir finden kein Kundenkonto
                dazu. Schreib uns kurz an{" "}
                <a
                    href={`mailto:${operator.email}`}
                    className="text-white underline decoration-zinc-600 underline-offset-4"
                >
                    {operator.email}
                </a>
                , dann richten wir das ein.
            </p>
        </div>
    );
}
