import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { type db as defaultDb, schema } from "@/db";
import { tokenMatches } from "@/lib/crypto";
import { recordNotification } from "./claim";

/**
 * Graph change notifications: what the webhook route is allowed to believe.
 *
 * A webhook route is unauthenticated by nature, so **the `clientState` check
 * is its authorization** — exactly as the signature check is for Stripe and
 * PayPal. It is a 32-byte secret we minted when we created the subscription,
 * stored hashed (`hashToken`, as an API key is) and compared in constant
 * time.
 *
 * And it is deliberately not the only thing standing there. Nothing in a
 * payload may name the row it acts on: a validated notification causes one
 * `mail_notification` row to be written, naming a message id in a mailbox we
 * already have a subscription for. The job then fetches that message **from
 * Graph**. A forged notification that somehow got past the clientState could
 * therefore cause a lookup of a message id that does not exist, and nothing
 * else at all.
 */

export const notificationSchema = z.object({
    value: z
        .array(
            z.object({
                subscriptionId: z.string().min(1),
                clientState: z.string().optional().nullable(),
                changeType: z.string().min(1),
                resource: z.string().optional().nullable(),
                resourceData: z
                    .object({ id: z.string().optional().nullable() })
                    .partial()
                    .optional()
                    .nullable(),
                tenantId: z.string().optional().nullable(),
                subscriptionExpirationDateTime: z
                    .string()
                    .optional()
                    .nullable(),
            }),
        )
        .max(200),
});

export type NotificationEnvelope = z.infer<typeof notificationSchema>;

export type AcceptedNotifications = {
    accepted: number;
    rejected: number;
};

type Db = Pick<typeof defaultDb, "select" | "insert" | "update" | "delete">;

/**
 * Takes a validated envelope and records what may be recorded.
 *
 * Each entry is checked on its own: a batch that mixes a good notification
 * with a forged one records the good one and counts the other as rejected,
 * rather than failing the whole delivery and making Graph retry the batch
 * for ever.
 */
export async function acceptNotifications(
    db: Db,
    envelope: NotificationEnvelope,
): Promise<AcceptedNotifications> {
    let accepted = 0;
    let rejected = 0;

    for (const entry of envelope.value) {
        const [subscription] = await db
            .select()
            .from(schema.mailSubscription)
            .where(
                and(
                    eq(
                        schema.mailSubscription.subscriptionId,
                        entry.subscriptionId,
                    ),
                    isNull(schema.mailSubscription.removedAt),
                ),
            )
            .limit(1);

        if (!subscription) {
            rejected += 1;
            continue;
        }

        if (
            !entry.clientState ||
            !tokenMatches(entry.clientState, subscription.clientStateHash)
        ) {
            // The one check that stands between this route and anybody with
            // the URL. A mismatch is never recorded and never retried.
            console.warn(
                "[tickets] a notification arrived with the wrong clientState for subscription",
                entry.subscriptionId,
            );
            rejected += 1;
            continue;
        }

        const resourceId =
            entry.resourceData?.id ?? idFromResource(entry.resource);

        if (!resourceId) {
            rejected += 1;
            continue;
        }

        await recordNotification(db, {
            channel: subscription.channel,
            mailbox: subscription.mailbox,
            subscriptionId: entry.subscriptionId,
            resourceId,
            changeType: entry.changeType,
        });

        accepted += 1;
    }

    return { accepted, rejected };
}

/**
 * `Users/…/Messages/AAMk…` — the shape Graph puts in `resource` when
 * `resourceData` is absent. Only ever used as a fallback, and only for the
 * last segment, which is the message id.
 */
export function idFromResource(
    resource: string | null | undefined,
): string | null {
    if (!resource) {
        return null;
    }

    const match = /Messages\/([^/?]+)/i.exec(resource);

    return match?.[1] ?? null;
}
