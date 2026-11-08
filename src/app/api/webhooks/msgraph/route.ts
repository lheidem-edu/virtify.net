import { db } from "@/db";
import {
    acceptNotifications,
    notificationSchema,
} from "@/server/tickets/notifications";

/**
 * Microsoft Graph change notifications.
 *
 * Two jobs, and nothing else.
 *
 * **The handshake.** Graph proves the endpoint is ours by POSTing with a
 * `validationToken` query parameter and expecting it back as `text/plain`
 * within ten seconds. There is no body to verify at that point, so the
 * handshake answers before anything else happens — and it echoes the token
 * verbatim, which is what the specification asks for and the only thing it
 * is allowed to do with it.
 *
 * **The notifications.** `clientState` is this route's authorization: an
 * unauthenticated route has nothing else, exactly as the Stripe and PayPal
 * routes have only their signature. It is checked per entry, in constant
 * time, against the hash stored when the subscription was created.
 *
 * Nothing in a payload may name the row it acts on. A valid notification
 * causes **one `mail_notification` row** to be written, saying "look at this
 * message id in this mailbox"; the worker then fetches that message from
 * Graph itself. A payload that somehow got past the clientState could
 * therefore provoke a lookup and nothing more — no ticket, no customer, no
 * invoice is named by anything that arrives here.
 *
 * The answer is 202 whatever happened, including for a batch where every
 * entry was rejected. Graph retries a non-2xx for hours and then disables
 * the subscription; a forged delivery must not be able to do that to a real
 * one.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Graph's documented ceiling for a notification batch. */
const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: Request) {
    const url = new URL(request.url);
    const validationToken = url.searchParams.get("validationToken");

    if (validationToken) {
        return new Response(validationToken, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }

    const body = await request.text();

    if (body.length > MAX_BODY_BYTES) {
        return new Response("payload too large", { status: 413 });
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(body);
    } catch {
        return new Response("invalid json", { status: 400 });
    }

    const envelope = notificationSchema.safeParse(parsed);

    if (!envelope.success) {
        return new Response("invalid payload", { status: 400 });
    }

    try {
        const result = await acceptNotifications(db, envelope.data);

        if (result.rejected > 0) {
            console.warn(
                `[tickets] ${result.rejected} of ${envelope.data.value.length} notifications were refused`,
            );
        }
    } catch (error) {
        // Recording failed, so nothing was claimed. A 500 is a real retry.
        console.error("[tickets] the msgraph webhook failed:", error);

        return new Response("handler failed", { status: 500 });
    }

    return new Response(null, { status: 202 });
}

/**
 * Graph validates a subscription's endpoint with a POST, but some tooling —
 * and an operator checking the URL by hand — sends a GET. Answering the
 * handshake here too costs nothing and saves an afternoon.
 */
export async function GET(request: Request) {
    const token = new URL(request.url).searchParams.get("validationToken");

    if (!token) {
        return new Response("ok", { status: 200 });
    }

    return new Response(token, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}
