import "server-only";
import type { db as defaultDb } from "@/db";
import { env } from "@/lib/env";
import { mailChannel } from "./channels";
import { pruneNotifications } from "./claim";
import { type SweepReport, sweepMailboxes } from "./reconcile";
import { loadMailChannelConfig } from "./settings";
import {
    type SubscriptionSyncReport,
    syncSubscriptions,
} from "./subscriptions";

/**
 * What the worker actually calls, and what "jetzt abholen" in the admin area
 * calls. One function, so the scheduled pass and the operator's button
 * cannot drift apart — the same arrangement `runBilling()` has.
 *
 * Every one of these is safe to run twice: the claims underneath
 * (`inbound_mail`, `mail_notification`) decide what work is left, not the
 * caller and not the clock. There is deliberately no `ticket_run (run_day)`
 * equivalent of `billing_run`: a mail sweep is not a daily event that must
 * happen once, it is a poll that should happen often, and a row saying "the
 * sweep has run today" would be exactly the wrong claim to make.
 */

type Db = typeof defaultDb;

export type TicketSweepResult = {
    ran: boolean;
    reason?: string;
    report?: SweepReport;
};

export async function runTicketSweep(
    db: Db,
    options: { reconcile?: boolean } = {},
): Promise<TicketSweepResult> {
    const config = await loadMailChannelConfig();
    const channel = await mailChannel(config.id);

    if (!channel) {
        return { ran: false, reason: "channel-not-configured" };
    }

    const report = await sweepMailboxes(
        db,
        { channel, config },
        { reconcile: options.reconcile },
    );

    // Notifications that were handled a week ago are of no further use; the
    // record that matters is `inbound_mail`, which is kept.
    await pruneNotifications(
        db,
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    );

    return { ran: true, report };
}

export type SubscriptionRunResult = {
    ran: boolean;
    reason?: string;
    report?: SubscriptionSyncReport;
};

/**
 * The notification endpoint Graph is told about.
 *
 * Built from `BETTER_AUTH_URL` — the public origin everything else in this
 * codebase builds a link from — and refused outright when it is not https.
 * Graph will not accept an http endpoint, and finding that out from a
 * subscription that silently never delivers is the expensive way.
 */
export function notificationUrl(): string | null {
    const base = env.BETTER_AUTH_URL;

    if (!base.startsWith("https://")) {
        return null;
    }

    return `${base.replace(/\/$/, "")}/api/webhooks/msgraph`;
}

export async function runSubscriptionSync(
    db: Db,
): Promise<SubscriptionRunResult> {
    const config = await loadMailChannelConfig();
    const channel = await mailChannel(config.id);

    if (!channel) {
        return { ran: false, reason: "channel-not-configured" };
    }

    const url = notificationUrl();

    if (!url) {
        return { ran: false, reason: "notification-url-not-https" };
    }

    const report = await syncSubscriptions(db, channel, {
        notificationUrl: url,
    });

    return { ran: true, report };
}
