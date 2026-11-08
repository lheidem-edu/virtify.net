import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { hashToken } from "@/lib/crypto";
import type { MailChannel } from "./channels/types";
import { listDepartments } from "./departments";

/**
 * Keeping the change-notification subscriptions alive.
 *
 * Graph grants a mailbox subscription for at most 4230 minutes — under three
 * days — and then stops delivering, silently. So a cron renews them well
 * before they expire, and the delta reconciliation underneath is what makes
 * a missed renewal an inconvenience rather than a day of lost support mail.
 *
 * The `clientState` is minted here, once, and stored **hashed**: it is the
 * webhook route's entire authorization, so it is treated exactly like an API
 * key. The consequence worth stating: a renewal cannot change it — Graph's
 * PATCH does not take one — so a subscription whose secret we have lost is
 * deleted and created afresh rather than patched.
 */

type Db = typeof defaultDb;

/** Ask for the maximum; renew at a third of it left. */
export const SUBSCRIPTION_MINUTES = 4_230;
export const RENEW_WHEN_MINUTES_LEFT = 1_440;

export type SubscriptionSyncReport = {
    created: string[];
    renewed: string[];
    failed: { mailbox: string; error: string }[];
    removed: string[];
};

function mintClientState(): string {
    return randomBytes(32).toString("base64url");
}

/**
 * Makes sure every active department's mailbox has a live subscription, and
 * that none of them is about to expire.
 *
 * Idempotent by construction: it reads what exists, compares it against what
 * should exist, and does the smallest thing that closes the gap. Running it
 * twice in a minute renews nothing twice.
 */
export async function syncSubscriptions(
    db: Db,
    channel: MailChannel,
    options: { notificationUrl: string; now?: Date },
): Promise<SubscriptionSyncReport> {
    const now = options.now ?? new Date();
    const report: SubscriptionSyncReport = {
        created: [],
        renewed: [],
        failed: [],
        removed: [],
    };

    const departments = await listDepartments(db, { activeOnly: true });
    const wanted = new Set(
        departments
            .filter((row) => row.channel === channel.id)
            .map((row) => row.mailbox.toLowerCase()),
    );

    const live = await db
        .select()
        .from(schema.mailSubscription)
        .where(
            and(
                eq(schema.mailSubscription.channel, channel.id),
                isNull(schema.mailSubscription.removedAt),
            ),
        );

    for (const subscription of live) {
        if (wanted.has(subscription.mailbox)) {
            continue;
        }

        // A department switched off or re-pointed. Its subscription would go
        // on delivering notifications for a mailbox nothing reads.
        try {
            await channel.deleteSubscription(subscription.subscriptionId);
        } catch (error) {
            report.failed.push({
                mailbox: subscription.mailbox,
                error: describe(error),
            });

            continue;
        }

        await db
            .update(schema.mailSubscription)
            .set({ removedAt: now, updatedAt: now })
            .where(eq(schema.mailSubscription.id, subscription.id));

        report.removed.push(subscription.mailbox);
    }

    for (const mailbox of wanted) {
        const existing = live.find((row) => row.mailbox === mailbox);

        try {
            if (!existing) {
                const clientState = mintClientState();
                const created = await channel.createSubscription({
                    mailbox,
                    notificationUrl: options.notificationUrl,
                    clientState,
                    minutes: SUBSCRIPTION_MINUTES,
                });

                await db.insert(schema.mailSubscription).values({
                    channel: channel.id,
                    mailbox,
                    resource: created.resource,
                    subscriptionId: created.subscriptionId,
                    clientStateHash: hashToken(clientState),
                    expiresAt: created.expiresAt,
                    lastRenewedAt: now,
                });

                report.created.push(mailbox);

                continue;
            }

            const minutesLeft =
                (existing.expiresAt.getTime() - now.getTime()) / 60_000;

            if (minutesLeft > RENEW_WHEN_MINUTES_LEFT) {
                continue;
            }

            const renewed = await channel.renewSubscription(
                existing.subscriptionId,
                SUBSCRIPTION_MINUTES,
            );

            await db
                .update(schema.mailSubscription)
                .set({
                    expiresAt: renewed.expiresAt,
                    lastRenewedAt: now,
                    updatedAt: now,
                })
                .where(eq(schema.mailSubscription.id, existing.id));

            report.renewed.push(mailbox);
        } catch (error) {
            /**
             * A renewal that fails because the subscription is gone — Graph
             * answers 404 once it has expired — is not a failure to report
             * and forget: the row is marked removed so the *next* pass
             * creates a fresh one instead of patching a corpse for ever.
             */
            if (existing && isGone(error)) {
                await db
                    .update(schema.mailSubscription)
                    .set({ removedAt: now, updatedAt: now })
                    .where(eq(schema.mailSubscription.id, existing.id));
            }

            report.failed.push({ mailbox, error: describe(error) });
        }
    }

    return report;
}

/** Subscriptions that will lapse before the next daily pass. */
export async function expiringSubscriptions(db: Db, within: Date) {
    return db
        .select()
        .from(schema.mailSubscription)
        .where(
            and(
                isNull(schema.mailSubscription.removedAt),
                lt(schema.mailSubscription.expiresAt, within),
            ),
        );
}

function isGone(error: unknown): boolean {
    const status = (error as { status?: number })?.status;

    return status === 404 || status === 410;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
