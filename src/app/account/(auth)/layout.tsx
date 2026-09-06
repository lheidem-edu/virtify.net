import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-session";

/**
 * Sign-in, registration and password recovery. Anyone already signed in is
 * sent to the account instead — otherwise the login form would render inside
 * the dashboard shell of the session they already have.
 */
export default async function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    if (await getSession()) {
        redirect("/account");
    }

    return <>{children}</>;
}
