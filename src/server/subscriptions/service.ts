import "server-only";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { ServiceStatus, SubscriptionStatus } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { pauseSpanMs, shiftInstant } from "@/server/billing/periods";
import { assertTransition, type ServiceFollow, servicesFollow } from "./state";

/**
 * The only way a subscription's status ever changes.
 *
 * Everything — the daily run, the admin buttons, the client's own cancel
 * form, `/api/v1/subscriptions/{id}/pause` — comes through
 * `transitionSubscriptionIn`. One door, for three reasons:
 *
 *  1. An illegal move throws (`state.ts`) instead of being written. A
 *     subscription that went from `ended` back to `active` would bill a
 *     customer whose services were torn down a month ago.
 *  2. The services follow here and nowhere else, so "past_due beyond grace →
 *     suspended, ended → terminated" is one statement rather than a rule
 *     every caller has to remember.
 *  3. The timeline the customer reads and the audit log rule 8 asks for are
 *     written in the same transaction as the change itself. An entry that
 *     survived a rollback would describe something that never happened.
 *
 * Every function here takes the transaction as a parameter: a status change
 * is almost never alone — it comes with an invoice, a credit entry or a
 * service being suspended — and those have to commit together or not at all.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class SubscriptionError extends Error {
    constructor(
        readonly code:
            | "not-found"
            | "not-live"
            | "not-paused"
            | "not-cancellable"
            | "item",
        message: string,
    ) {
        super(message);
        this.name = "SubscriptionError";
    }
}

export async function lockSubscription(tx: Tx, id: string) {
    const [row] = await tx
        .select()
        .from(schema.subscription)
        .where(eq(schema.subscription.id, id))
        .for("update");

    if (!row) {
        throw new SubscriptionError("not-found", "Dieses Abo gibt es nicht.");
    }

    return row;
}

/** A line on the Abo's own timeline. German — the customer reads it. */
export async function recordEvent(
    tx: Tx,
    input: {
        subscriptionId: string;
        kind: "status" | "period" | "change" | "dunning" | "note";
        summary: string;
        fromStatus?: string | null;
        toStatus?: string | null;
        data?: Record<string, unknown>;
        actor: Actor;
        at: Date;
    },
) {
    await tx.insert(schema.subscriptionEvent).values({
        id: createId("subscriptionevent"),
        subscriptionId: input.subscriptionId,
        kind: input.kind,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        summary: input.summary,
        data: input.data ?? {},
        actorType: input.actor.type,
        actorLabel: input.actor.label ?? null,
        at: input.at,
    });
}

/**
 * The services under a subscription, moved to where the new status says
 * they belong.
 *
 * Narrow on purpose:
 *  - a service is only *woken* if it was suspended. One still `pending` has
 *    never been set up and must not be declared active by a status change;
 *  - a terminated service stays terminated, whatever happens afterwards.
 *    Tearing something down is not undone by a status;
 *  - `provisioning` is left alone: a module is working on it (Phase 8), and
 *    pulling the row out from under it would lose whatever it is holding.
 */
export async function applyServiceFollow(
    tx: Tx,
    subscriptionId: string,
    follow: ServiceFollow,
    at: Date,
): Promise<number> {
    if (follow === null) {
        return 0;
    }

    const items = await tx
        .select({ id: schema.subscriptionItem.id })
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.subscriptionId, subscriptionId));

    if (items.length === 0) {
        return 0;
    }

    const ids = items.map((item) => item.id);
    const from: ServiceStatus[] =
        follow === "terminated"
            ? ["pending", "provisioning", "active", "suspended"]
            : follow === "suspended"
              ? ["active"]
              : ["suspended"];

    const stamp =
        follow === "terminated"
            ? { terminatedAt: at }
            : follow === "suspended"
              ? { suspendedAt: at }
              : { suspendedAt: null, activatedAt: at };

    const updated = await tx
        .update(schema.service)
        .set({ status: follow, ...stamp, updatedAt: at })
        .where(
            and(
                inArray(schema.service.subscriptionItemId, ids),
                inArray(schema.service.status, from),
            ),
        )
        .returning({ id: schema.service.id });

    return updated.length;
}

export type TransitionInput = {
    subscriptionId: string;
    to: SubscriptionStatus;
    /** German, shown on the timeline. */
    summary: string;
    actor: Actor;
    at: Date;
    data?: Record<string, unknown>;
    /**
     * Services follow by default. The one caller that passes `false` is
     * dunning's suspension, which moves the services itself at a rung of
     * its own while the subscription merely becomes `past_due`.
     */
    moveServices?: boolean;
};

export type TransitionResult = {
    changed: boolean;
    from: SubscriptionStatus;
    to: SubscriptionStatus;
    servicesMoved: number;
};

/**
 * Moves one subscription, with its row already locked by the caller or
 * locked here.
 *
 * Returns `changed: false` when it is already where it is being asked to go.
 * That is not an error — two runs on the same day, a webhook and a button
 * all reaching for `active` is the normal case — but it writes no timeline
 * entry, because "von active nach active" is noise in a history a customer
 * reads.
 */
export async function transitionSubscriptionIn(
    tx: Tx,
    input: TransitionInput,
): Promise<TransitionResult> {
    const row = await lockSubscription(tx, input.subscriptionId);
    const from = row.status;

    if (from === input.to) {
        return { changed: false, from, to: input.to, servicesMoved: 0 };
    }

    assertTransition(from, input.to);

    const at = input.at;
    const patch: Partial<typeof schema.subscription.$inferInsert> = {
        status: input.to,
        updatedAt: at,
    };

    switch (input.to) {
        case "paused":
            patch.pausedAt = at;
            /**
             * A paused Abo raises no invoice. Clearing the date is what
             * stops the renewal run seeing it; the date itself comes back on
             * resume, moved forward by exactly the time it stood still.
             */
            patch.nextBillingAt = null;
            break;
        case "active": {
            if (from === "paused" && row.pausedAt) {
                /**
                 * The mirror of pausing: the period end and the billing date
                 * move forward by the span the Abo stood still, computed
                 * once by `pauseSpanMs`. The customer neither loses the days
                 * they could not use nor gains any.
                 */
                const span = pauseSpanMs(row.pausedAt, at);

                patch.currentPeriodEnd = shiftInstant(
                    row.currentPeriodEnd,
                    span,
                );
                patch.nextBillingAt = shiftInstant(row.currentPeriodEnd, span);
                patch.trialEndsAt = shiftInstant(row.trialEndsAt, span);
            }

            patch.pausedAt = null;
            patch.pastDueAt = null;
            /**
             * `cancel_at_period_end` and `cancelled_at` are deliberately
             * *not* cleared here. Becoming active again happens for several
             * reasons — a payment arrived, a pause ended, a period rolled
             * over — and only one of them means "the cancellation is off".
             * That one is `resumeCancellation`, which clears both itself.
             * Clearing them here would have let resuming a paused Abo
             * silently un-cancel it.
             */
            break;
        }
        case "past_due":
            patch.pastDueAt = row.pastDueAt ?? at;
            break;
        case "cancelled":
            patch.cancelledAt = row.cancelledAt ?? at;
            break;
        case "ended":
            patch.endedAt = at;
            patch.nextBillingAt = null;
            patch.pausedAt = null;
            break;
        default:
            break;
    }

    await tx
        .update(schema.subscription)
        .set(patch)
        .where(eq(schema.subscription.id, input.subscriptionId));

    const servicesMoved =
        input.moveServices === false
            ? 0
            : await applyServiceFollow(
                  tx,
                  input.subscriptionId,
                  servicesFollow(input.to),
                  at,
              );

    await recordEvent(tx, {
        subscriptionId: input.subscriptionId,
        kind: "status",
        summary: input.summary,
        fromStatus: from,
        toStatus: input.to,
        data: { ...input.data, servicesMoved },
        actor: input.actor,
        at,
    });

    await audit(tx, {
        actor: input.actor,
        action: "subscription.transition",
        entityType: "subscription",
        entityId: input.subscriptionId,
        before: { status: from },
        after: { status: input.to, reason: input.summary, servicesMoved },
    });

    return { changed: true, from, to: input.to, servicesMoved };
}

/** The same thing when the caller has no transaction of its own. */
export async function transitionSubscription(
    db: Db,
    input: TransitionInput,
): Promise<TransitionResult> {
    return db.transaction((tx) => transitionSubscriptionIn(tx, input));
}

export type CancelInput = {
    subscriptionId: string;
    /** `now` ends it today; `period_end` lets the paid period run out. */
    when: "now" | "period_end";
    reason?: string | null;
    actor: Actor;
    at?: Date;
};

/**
 * Cancels an Abo, in the two ways a customer means it.
 *
 * `period_end` is the ordinary one and moves no money: the Abo stops
 * renewing, the services keep running to the end of the period that has
 * been paid for, and the run ends it on the day. `now` ends it today and
 * terminates the services.
 *
 * Neither refunds anything. § 8 of the terms leaves that to the operator,
 * and a cancellation that quietly issued a Rechnungskorrektur would be the
 * panel deciding something nobody asked it to.
 */
export async function cancelSubscription(db: Db, input: CancelInput) {
    const at = input.at ?? new Date();

    return db.transaction(async (tx) => {
        const row = await lockSubscription(tx, input.subscriptionId);

        if (row.status === "ended") {
            throw new SubscriptionError(
                "not-cancellable",
                "Dieses Abo ist bereits beendet.",
            );
        }

        if (input.when === "now") {
            await transitionSubscriptionIn(tx, {
                subscriptionId: row.id,
                to: "ended",
                summary: input.reason?.trim()
                    ? `Sofort gekündigt: ${input.reason.trim()}`
                    : "Sofort gekündigt.",
                actor: input.actor,
                at,
            });

            return { status: "ended" as const, endsAt: at };
        }

        await tx
            .update(schema.subscription)
            .set({
                cancelAtPeriodEnd: true,
                note: input.reason?.trim() || row.note,
                updatedAt: at,
            })
            .where(eq(schema.subscription.id, row.id));

        /**
         * `cancelled` says "will not renew" — the Abo keeps running. A
         * paused one keeps its own status: it is not running, and marking it
         * cancelled would lose the fact that it is also paused.
         */
        if (row.status !== "paused") {
            await transitionSubscriptionIn(tx, {
                subscriptionId: row.id,
                to: "cancelled",
                summary: `Zum Ende des Zeitraums gekündigt${
                    input.reason?.trim() ? `: ${input.reason.trim()}` : "."
                }`,
                actor: input.actor,
                at,
                data: { cancelAtPeriodEnd: true },
            });
        } else {
            await recordEvent(tx, {
                subscriptionId: row.id,
                kind: "status",
                summary: "Zum Ende des Zeitraums gekündigt.",
                actor: input.actor,
                at,
            });
        }

        return {
            status: "cancelled" as const,
            endsAt: row.currentPeriodEnd,
        };
    });
}

/** Takes a cancellation back, while there is still a period to take it in. */
export async function resumeCancellation(
    db: Db,
    input: { subscriptionId: string; actor: Actor; at?: Date },
) {
    const at = input.at ?? new Date();

    return db.transaction(async (tx) => {
        const row = await lockSubscription(tx, input.subscriptionId);

        if (row.status === "ended") {
            throw new SubscriptionError(
                "not-live",
                "Ein beendetes Abo kann nicht fortgesetzt werden.",
            );
        }

        if (!row.cancelAtPeriodEnd && row.status !== "cancelled") {
            throw new SubscriptionError(
                "not-cancellable",
                "Dieses Abo ist nicht gekündigt.",
            );
        }

        await tx
            .update(schema.subscription)
            .set({
                cancelAtPeriodEnd: false,
                cancelledAt: null,
                updatedAt: at,
            })
            .where(eq(schema.subscription.id, row.id));

        if (row.status === "cancelled") {
            await transitionSubscriptionIn(tx, {
                subscriptionId: row.id,
                to: "active",
                summary: "Kündigung zurückgenommen.",
                actor: input.actor,
                at,
            });
        } else {
            await recordEvent(tx, {
                subscriptionId: row.id,
                kind: "status",
                summary: "Kündigung zurückgenommen.",
                actor: input.actor,
                at,
            });
        }

        return { cancelAtPeriodEnd: false };
    });
}

/** Stops the clock: no invoices, services suspended. */
export async function pauseSubscription(
    db: Db,
    input: {
        subscriptionId: string;
        reason?: string | null;
        actor: Actor;
        at?: Date;
    },
) {
    const at = input.at ?? new Date();

    return db.transaction((tx) =>
        transitionSubscriptionIn(tx, {
            subscriptionId: input.subscriptionId,
            to: "paused",
            summary: input.reason?.trim()
                ? `Pausiert: ${input.reason.trim()}`
                : "Pausiert.",
            actor: input.actor,
            at,
        }),
    );
}

/** Starts it again, and gives back exactly the days that stood still. */
export async function resumeSubscription(
    db: Db,
    input: { subscriptionId: string; actor: Actor; at?: Date },
) {
    const at = input.at ?? new Date();

    return db.transaction(async (tx) => {
        const row = await lockSubscription(tx, input.subscriptionId);

        if (row.status !== "paused") {
            throw new SubscriptionError(
                "not-paused",
                "Dieses Abo ist nicht pausiert.",
            );
        }

        return transitionSubscriptionIn(tx, {
            subscriptionId: row.id,
            to: "active",
            summary: "Fortgesetzt.",
            actor: input.actor,
            at,
            data: { pausedAt: row.pausedAt?.toISOString() ?? null },
        });
    });
}

/**
 * The operator moving a billing date or a price by hand.
 *
 * It writes the item's snapshot, not the catalog — which is what a price
 * change on a running Abo *is*. A change the customer should see priced
 * before they agree to it goes through `./changes.ts` instead; this is the
 * escape hatch for the cases that are a conversation rather than a form.
 */
export async function adjustSubscription(
    db: Db,
    input: {
        subscriptionId: string;
        nextBillingAt?: Date | null;
        autoCharge?: boolean;
        paymentMethodId?: string | null;
        items?: { id: string; unitPriceCents: number }[];
        note?: string | null;
        actor: Actor;
        at?: Date;
    },
) {
    const at = input.at ?? new Date();

    return db.transaction(async (tx) => {
        const row = await lockSubscription(tx, input.subscriptionId);
        const changes: Record<string, unknown> = {};
        const patch: Partial<typeof schema.subscription.$inferInsert> = {
            updatedAt: at,
        };

        if (
            input.nextBillingAt !== undefined &&
            input.nextBillingAt?.getTime() !== row.nextBillingAt?.getTime()
        ) {
            patch.nextBillingAt = input.nextBillingAt;
            changes.nextBillingAt = input.nextBillingAt?.toISOString() ?? null;
        }

        if (
            input.autoCharge !== undefined &&
            input.autoCharge !== row.autoCharge
        ) {
            patch.autoCharge = input.autoCharge;
            changes.autoCharge = input.autoCharge;
        }

        if (
            input.paymentMethodId !== undefined &&
            input.paymentMethodId !== row.paymentMethodId
        ) {
            patch.paymentMethodId = input.paymentMethodId;
            changes.paymentMethodId = input.paymentMethodId;
        }

        if (input.note !== undefined) {
            patch.note = input.note?.trim() || null;
        }

        await tx
            .update(schema.subscription)
            .set(patch)
            .where(eq(schema.subscription.id, row.id));

        for (const item of input.items ?? []) {
            const [existing] = await tx
                .select()
                .from(schema.subscriptionItem)
                .where(
                    and(
                        eq(schema.subscriptionItem.id, item.id),
                        eq(schema.subscriptionItem.subscriptionId, row.id),
                    ),
                );

            if (!existing) {
                throw new SubscriptionError(
                    "item",
                    "Diese Position gehört nicht zu diesem Abo.",
                );
            }

            if (existing.unitPriceCents === item.unitPriceCents) {
                continue;
            }

            /**
             * The add-ons keep the prices they were sold at; only the base
             * moves. `recurring_gross_cents` is base plus add-ons for one
             * period, so the difference is what the base moved by — recomputing
             * it from the selections would be a second arithmetic for a figure
             * the row already holds.
             */
            const delta = item.unitPriceCents - existing.unitPriceCents;

            await tx
                .update(schema.subscriptionItem)
                .set({
                    unitPriceCents: item.unitPriceCents,
                    recurringGrossCents:
                        existing.recurringGrossCents +
                        delta * existing.quantity,
                    updatedAt: at,
                })
                .where(eq(schema.subscriptionItem.id, item.id));

            changes[`item:${item.id}`] = {
                from: existing.unitPriceCents,
                to: item.unitPriceCents,
            };
        }

        if (Object.keys(changes).length > 0) {
            await recordEvent(tx, {
                subscriptionId: row.id,
                kind: "note",
                summary: "Von Hand angepasst.",
                data: changes,
                actor: input.actor,
                at,
            });

            await audit(tx, {
                actor: input.actor,
                action: "subscription.adjust",
                entityType: "subscription",
                entityId: row.id,
                after: changes,
            });
        }

        return changes;
    });
}

/**
 * Brings a subscription back once everything it owes has been settled —
 * the mirror of dunning, and the reason a customer who pays at midnight has
 * their server back at one minute past.
 *
 * It is called from two places and both are deliberate: `emitInvoicePaid`,
 * which is the seam every settled payment passes through, and the daily run,
 * which catches anything a failed mail or a crashed process dropped. Both end
 * here, so there is one rule about what "paid up" means.
 */
export async function reactivateAfterSettlement(
    db: Db,
    invoiceId: string,
    at = new Date(),
    actor: Actor = { type: "system", label: "settlement" },
): Promise<string[]> {
    const links = await db
        .select({ subscriptionId: schema.subscriptionInvoice.subscriptionId })
        .from(schema.subscriptionInvoice)
        .where(eq(schema.subscriptionInvoice.invoiceId, invoiceId));

    const woken: string[] = [];

    for (const link of links) {
        const back = await db.transaction(async (tx) => {
            const row = await lockSubscription(tx, link.subscriptionId);

            if (row.status !== "past_due") {
                return false;
            }

            if (await hasOpenInvoice(tx, row.id)) {
                return false;
            }

            await transitionSubscriptionIn(tx, {
                subscriptionId: row.id,
                to: "active",
                summary: "Zahlung eingegangen — wieder aktiv.",
                actor,
                at,
            });

            return true;
        });

        if (back) {
            woken.push(link.subscriptionId);
        }
    }

    return woken;
}

/**
 * Whether anything this subscription is on the hook for is still open.
 *
 * `OPEN_INVOICE_STATUSES` rather than a literal, because a half-paid invoice
 * is an open one: a customer who sent 10 € against a 30 € renewal has not
 * paid up, and comparing against `"unpaid"` would wake their server anyway.
 */
export async function hasOpenInvoice(
    tx: Tx,
    subscriptionId: string,
): Promise<boolean> {
    const [open] = await tx
        .select({ id: schema.invoice.id })
        .from(schema.subscriptionInvoice)
        .innerJoin(
            schema.invoice,
            eq(schema.subscriptionInvoice.invoiceId, schema.invoice.id),
        )
        .where(
            and(
                eq(schema.subscriptionInvoice.subscriptionId, subscriptionId),
                inArray(schema.invoice.status, [
                    ...schema.OPEN_INVOICE_STATUSES,
                ]),
            ),
        )
        .limit(1);

    return Boolean(open);
}

/** Every subscription an invoice is raised against. */
export async function subscriptionsForInvoice(
    executor: Db | Tx,
    invoiceId: string,
) {
    return executor
        .select({
            subscriptionId: schema.subscriptionInvoice.subscriptionId,
            kind: schema.subscriptionInvoice.kind,
            periodStart: schema.subscriptionInvoice.periodStart,
            periodEnd: schema.subscriptionInvoice.periodEnd,
        })
        .from(schema.subscriptionInvoice)
        .where(eq(schema.subscriptionInvoice.invoiceId, invoiceId));
}

/** The stored card a subscription behind an invoice names, if any. */
export async function methodForInvoice(executor: Db | Tx, invoiceId: string) {
    const [row] = await executor
        .select({
            id: schema.paymentMethod.id,
            provider: schema.paymentMethod.provider,
            token: schema.paymentMethod.token,
            label: schema.paymentMethod.label,
        })
        .from(schema.subscriptionInvoice)
        .innerJoin(
            schema.subscription,
            eq(
                schema.subscriptionInvoice.subscriptionId,
                schema.subscription.id,
            ),
        )
        .innerJoin(
            schema.paymentMethod,
            eq(schema.subscription.paymentMethodId, schema.paymentMethod.id),
        )
        .where(
            and(
                eq(schema.subscriptionInvoice.invoiceId, invoiceId),
                eq(schema.subscription.autoCharge, true),
                isNull(schema.paymentMethod.revokedAt),
                ne(schema.subscription.status, "ended"),
            ),
        )
        .limit(1);

    return row ?? null;
}
