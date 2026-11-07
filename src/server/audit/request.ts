import "server-only";
import { headers } from "next/headers";

/**
 * Where the request came from, for the two fields hard rule 8 asks for. Kept
 * out of ./index.ts so the audit helper itself stays framework-free and can
 * be called from a job, a script or a test.
 *
 * Behind a proxy the socket address is the proxy's, so the forwarded header
 * wins — it is only trustworthy because nothing but our own reverse proxy
 * can set what reaches the application.
 */
export async function requestOrigin(): Promise<{
    ip: string | null;
    userAgent: string | null;
}> {
    const head = await headers();
    const forwarded = head.get("x-forwarded-for");

    return {
        ip: forwarded?.split(",")[0]?.trim() ?? head.get("x-real-ip") ?? null,
        userAgent: head.get("user-agent"),
    };
}
