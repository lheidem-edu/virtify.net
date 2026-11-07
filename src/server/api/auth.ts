import { db } from "@/db";
import { forbidden, unauthorized } from "@/server/api/respond";
import {
    type ApiContext,
    authenticateApiKey,
    contextCan,
} from "@/server/api-keys";
import type { Permission } from "@/server/auth/permissions";

/**
 * The gate in front of `/api/v1`. Every handler starts here and gets back
 * either a `Response` to return as it stands or the context that says who is
 * asking and what they may do.
 *
 * Returning the refusal rather than throwing it keeps the handler's happy
 * path free of try/catch, and makes forgetting the check a type error: the
 * union cannot be used as a context without narrowing it first.
 */
export type Authenticated =
    | { ok: true; context: ApiContext }
    | { ok: false; response: Response };

function bearer(request: Request): string | null {
    const header = request.headers.get("authorization");

    if (!header) {
        return null;
    }

    const [scheme, ...rest] = header.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return null;
    }

    const token = rest.join(" ").trim();

    return token === "" ? null : token;
}

export async function authenticate(
    request: Request,
    needed: Permission,
): Promise<Authenticated> {
    const token = bearer(request);

    if (!token) {
        return { ok: false, response: unauthorized() };
    }

    const context = await authenticateApiKey(db, token);

    if (!context) {
        // Deliberately the same answer for an unknown, a revoked and an
        // expired key: telling them apart would turn the endpoint into an
        // oracle for which tokens once existed.
        return {
            ok: false,
            response: unauthorized(
                "Der Schlüssel ist unbekannt, widerrufen oder abgelaufen.",
            ),
        };
    }

    if (!contextCan(context, needed)) {
        return {
            ok: false,
            response: forbidden(
                `Dieser Schlüssel deckt \`${needed}\` nicht ab.`,
            ),
        };
    }

    return { ok: true, context };
}

/**
 * The customer a key may act for, or null for a staff key, which may act for
 * all of them. Handlers that take an id compare it against this and answer
 * 404 when it does not match — not 403, which would confirm the row exists.
 */
export function scopedCustomerId(context: ApiContext): string | null {
    return context.owner.type === "customer" ? context.owner.customerId : null;
}
