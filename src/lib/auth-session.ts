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
        redirect("/account/login");
    }

    return session;
}
