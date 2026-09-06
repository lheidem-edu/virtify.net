import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/** The session for the current request, or null when signed out. */
export async function getSession() {
    return auth.api.getSession({ headers: await headers() });
}

/** Guard for the customer area. Redirects to the login instead of throwing. */
export async function requireSession() {
    const session = await getSession();

    if (!session) {
        redirect("/customer/login");
    }

    return session;
}

/** Guard for the admin area. Unauthenticated users are sent to the login;
 *  authenticated non-admins get a 404 rather than a 403, so the existence of
 *  the area is not confirmed to them. */
export async function requireAdmin() {
    const session = await requireSession();

    if (session.user.role !== "admin") {
        const { notFound } = await import("next/navigation");
        notFound();
    }

    return session;
}
