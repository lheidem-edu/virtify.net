import Link from "next/link";
import { PERMISSIONS } from "@/server/auth/permissions";
import { requireStaffSession } from "@/server/auth/staff-session";

export const dynamic = "force-dynamic";

/**
 * Where `requirePermission()` sends an employee who opened something their
 * roles do not cover. It names the permission rather than the page, because
 * that is what the operator has to grant to change the answer.
 */
export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{ permission?: string }>;
}) {
    await requireStaffSession();

    const { permission } = await searchParams;
    const described =
        permission && permission in PERMISSIONS
            ? PERMISSIONS[permission as keyof typeof PERMISSIONS]
            : null;

    return (
        <div className="px-6 py-16 md:px-10 md:py-20">
            <h1 className="text-3xl font-semibold tracking-tight">
                Dafür fehlt dir die Berechtigung
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                {described
                    ? `Dieser Bereich verlangt „${described}“ (${permission}).`
                    : "Dieser Bereich ist deinen Rollen nicht zugeordnet."}{" "}
                Wende dich an eine Kollegin oder einen Kollegen mit der Rolle
                „Super Admin“.
            </p>
            <Link
                href="/admin"
                className="mt-8 inline-block text-sm underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white"
            >
                Zurück zur Übersicht
            </Link>
        </div>
    );
}
