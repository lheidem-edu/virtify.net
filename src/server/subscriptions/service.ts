import "server-only";
import { and, asc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { ServiceStatus, SubscriptionStatus } from "@/db/schema";
import { formatDate } from "@/lib/format";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { pauseSpanMs, shiftInstant } from "@/server/billing/periods";
/**
 * The way back, imported from where it is kept. `reversals.ts` imports this
 * file in turn — a cancellation is a status change and a correction at once,
 * and neither module may own both — which is a cycle only on paper: each
 * side reaches for the other inside a function body, never while the module
 * is being evaluated.
 */
import { cancelUndeliveredRenewalsIn } from "@/server/billing/reversals";
import { loadSettings, type Settings } from "@/server/settings";
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
            | "renewal-invoiced"
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
        /** Minted by the caller where it is also a request key (Phase 8). */
        id?: string;
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
        id: input.id ?? createId("subscriptionevent"),
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
    /**
     * Phase 8. The id of the status change that caused this — the
     * subscription event, the dunning action — which becomes the request key
     * of the module call that follows. It has to be **unique per
     * occurrence**: an Abo suspended twice over a year is two causes and two
     * suspensions, while the same transition reached twice in one
     * transaction is one cause and one.
     *
     * Omitted means "move the rows and tell nobody", which is right for the
     * places that are not a lifecycle event at all.
     */
    cause?: string | null,
): Promise<string[]> {
    if (follow === null) {
        return [];
    }

    const items = await tx
        .select({ id: schema.subscriptionItem.id })
        .from(schema.subscriptionItem)
        .where(eq(schema.subscriptionItem.subscriptionId, subscriptionId));

    if (items.length === 0) {
        return [];
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

    const moved = updated.map((row) => row.id);

    /**
     * **The loop-breaker.** The update above moves only services whose
     * status is in the set it is moving *from*, so writing the same follow
     * twice moves zero rows — and the module calls are enqueued off the rows
     * that actually moved, never off the statuses they now have. A hook that
     * fired on the value rather than on the change would re-suspend an
     * already suspended machine for as long as anything kept asking.
     */
    if (cause && moved.length > 0) {
        const { onServicesFollowed } = await import(
            "@/server/provisioning/hooks"
        );

        await onServicesFollowed(tx, {
            serviceIds: moved,
            follow,
            cause,
        });
    }

    return moved;
}

/**
 * A renewal that is already on a document for a period the Abo has not
 * reached yet — the one thing that makes its period unmovable.
 *
 * `subscription_invoice (subscription_id, period_start, kind)` is what makes
 * a period be invoiced exactly once, and it is keyed on the **day** the
 * period starts. Anything that moves that day while an invoice stands for
 * the old one takes the Abo out from under its own unique index: the next
 * renewal pass asks about a day nobody has invoiced, finds nothing, and
 * raises a second document over a month that is already billed.
 *
 * A fully credited invoice is not one of those. `cancelRenewalInvoice`
 * deletes the link outright, so it is gone from here anyway; an ordinary
 * Rechnungskorrektur over the whole renewal leaves the link but takes the
 * document back to `cancelled`, and a document that no longer stands cannot
 * be billed twice.
 */
export async function invoicedRenewalAhead(
    tx: Tx,
    row: { id: string; currentPeriodEnd: Date | null },
) {
    if (!row.currentPeriodEnd) {
        // A one-off has no period to move, and no renewal to collide with.
        return null;
    }

    const [ahead] = await tx
        .select({
            invoiceId: schema.invoice.id,
            number: schema.invoice.number,
            status: schema.invoice.status,
            periodStart: schema.subscriptionInvoice.periodStart,
        })
        .from(schema.subscriptionInvoice)
        .innerJoin(
            schema.invoice,
            eq(schema.subscriptionInvoice.invoiceId, schema.invoice.id),
        )
        .where(
            and(
                eq(schema.subscriptionInvoice.subscriptionId, row.id),
                eq(schema.subscriptionInvoice.kind, "renewal"),
                // At or after the end of the period being run: the one the
                // Abo is about to enter, and anything beyond it. The period
                // it is *in* was invoiced long ago and does not move.
                gte(
                    schema.subscriptionInvoice.periodStart,
                    row.currentPeriodEnd,
                ),
                ne(schema.invoice.status, "cancelled"),
            ),
        )
        .orderBy(asc(schema.subscriptionInvoice.periodStart))
        .limit(1);

    return ahead ?? null;
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
        case "paused": {
            /**
             * Not while the coming period is already on a finalized
             * document.
             *
             * Resuming moves the period end forward by the span the Abo
             * stood still, and a period that has moved is a period the
             * renewal run no longer recognises as invoiced: it would raise a
             * second Verlängerung over a month the customer has already been
             * billed — and, with auto-charge, already paid.
             *
             * Neither of the two ways out may be taken here. Leaving the
             * period where the invoice says it is would bill the customer
             * for days their services were suspended; crediting the invoice
             * would be the panel issuing a Rechnungskorrektur — a legal
             * document out of the gapless range — because somebody pressed
             * "pausieren", which is exactly what `cancelSubscription`
             * refuses to do for the same reason. So the Abo says no, and
             * says what to do instead: take the Verlängerung back
             * (`cancelRenewalInvoice`, the one way this project undoes one),
             * or pause once the new period has begun.
             */
            const ahead = await invoicedRenewalAhead(tx, row);

            if (ahead) {
                throw new SubscriptionError(
                    "renewal-invoiced",
                    `Die Verlängerung für den Zeitraum ab ${formatDate(
                        ahead.periodStart,
                    )} ist bereits berechnet${
                        ahead.number ? ` (Rechnung ${ahead.number})` : ""
                    }. Nehmen Sie die Verlängerung zurück oder pausieren Sie, sobald der neue Zeitraum begonnen hat.`,
                );
            }

            patch.pausedAt = at;
            /**
             * A paused Abo raises no invoice. Clearing the date is what
             * stops the renewal run seeing it; the date itself comes back on
             * resume, moved forward by exactly the time it stood still.
             */
            patch.nextBillingAt = null;
            break;
        }
        case "active": {
            if (from === "paused" && row.pausedAt) {
                /**
                 * The mirror of pausing: the period end and the billing date
                 * move forward by the span the Abo stood still, computed
                 * once by `pauseSpanMs`. The customer neither loses the days
                 * they could not use nor gains any.
                 *
                 * It may move freely because the pause above refused to
                 * start while a Verlängerung stood for the coming period,
                 * and a paused Abo cannot acquire one: it has no
                 * `next_billing_at` and its status is not billable.
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

    /**
     * The services follow — unless dunning is holding them.
     *
     * `suspended` is one service status for two different things: a pause
     * the customer asked for, and the rung that pulled the plug on an unpaid
     * invoice. Only the first is theirs to lift. Without this question
     * „Kündigen“ followed by „Kündigung zurücknehmen“ — two buttons the
     * client portal already offers — walked a suspended server back to
     * `active` with the invoice still open, and the rung that stopped it
     * never fires again, because `dunning_action (invoice_id, 'suspend')` is
     * claimed for ever.
     *
     * The hold asks `isOpenInvoice()` and no status literal (rule 3), so the
     * grace between the due date and the suspension rung is untouched:
     * nothing has been suspended there yet, and a pause the customer lifts
     * still wakes their services. What takes the hold off is the money
     * arriving — `reactivateAfterSettlement` below.
     */
    let follow: ServiceFollow = null;
    let heldByDunning = false;

    if (input.moveServices !== false) {
        follow = servicesFollow(input.to);

        if (
            follow === "active" &&
            (await hasDunningSuspension(tx, input.subscriptionId))
        ) {
            follow = null;
            heldByDunning = true;
        }
    }

    /**
     * The event id is minted here rather than inside `recordEvent`, because
     * it is also the **cause** the module call is keyed on: one status
     * change is one suspension, and the timeline entry and the Proxmox task
     * then name each other.
     */
    const eventId = createId("subscriptionevent");

    const servicesMoved = (
        await applyServiceFollow(tx, input.subscriptionId, follow, at, eventId)
    ).length;

    await recordEvent(tx, {
        id: eventId,
        subscriptionId: input.subscriptionId,
        kind: "status",
        summary: input.summary,
        fromStatus: from,
        toStatus: input.to,
        data: {
            ...input.data,
            servicesMoved,
            ...(heldByDunning ? { servicesHeld: "dunning" } : {}),
        },
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
    settings?: Settings;
};

/**
 * Cancels an Abo, in the two ways a customer means it.
 *
 * `period_end` is the ordinary one: the Abo stops renewing, the services
 * keep running to the end of the period that has been paid for, and the run
 * ends it on the day. `now` ends it today and terminates the services.
 *
 * Neither refunds a period that was delivered. § 8 of the terms leaves that
 * to the operator, and a cancellation that quietly credited days the
 * customer had used would be the panel deciding something nobody asked it
 * to.
 *
 * What it does take back is a period that will **not** be delivered. A
 * renewal is invoiced ahead of its period — which is exactly the window
 * people cancel in, because that invoice is what reminds them — and an
 * invoice for a month in which nothing runs is not a decision, it is an
 * error: the card is debited on the due date, and after it come a
 * Zahlungserinnerung, a Mahnung with its own Gebührenrechnung and a
 * Kündigungsandrohung. `cancelUndeliveredRenewalsIn` takes it back the one
 * way the project has, in this transaction, so the Abo's new status and the
 * Rechnungskorrektur commit together.
 */
export async function cancelSubscription(db: Db, input: CancelInput) {
    const at = input.at ?? new Date();
    const settings = input.settings ?? (await loadSettings());

    return db.transaction(async (tx) => {
        const row = await lockSubscription(tx, input.subscriptionId);

        if (row.status === "ended") {
            throw new SubscriptionError(
                "not-cancellable",
                "Dieses Abo ist bereits beendet.",
            );
        }

        /**
         * Before the status moves, deliberately: the reversal reads the Abo
         * as it still is, and the billing date it leaves standing is what
         * lets `resumeCancellation` have the period invoiced again.
         */
        const reversed = await cancelUndeliveredRenewalsIn(tx, {
            subscriptionId: row.id,
            endsAt: input.when === "now" ? at : row.currentPeriodEnd,
            actor: input.actor,
            at,
            settings,
        });

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

            return { status: "ended" as const, endsAt: at, reversed };
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
            /** The renewals this cancellation took back off the books. */
            reversed,
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

/**
 * Stops the clock: no invoices, services suspended.
 *
 * Refused while the coming period is already on a standing Verlängerung —
 * see the `paused` case of `transitionSubscriptionIn`.
 */
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

export type WakeResult = {
    /** Whether anything moved — the status, the services, or both. */
    woken: boolean;
    servicesWoken: number;
};

/**
 * One subscription that owes nothing any more, brought back. The single
 * answer to "has this one paid up?", for both halves of the mirror.
 *
 * The question it asks is deliberately **not** "is the label `past_due`".
 * Dunning suspends the services at +14 with `applyServiceFollow` and leaves
 * the label alone wherever `past_due` would be a lie — a gekündigtes Abo
 * stays `cancelled` while it is being chased, because `cancelled` says
 * something truer. Asking for the label on the way back therefore left
 * exactly those customers switched off: they paid the last invoice of a
 * period they had already paid for, the Sperrung mail promised them the
 * server back, and nothing woke it until the cancellation closed the Abo.
 *
 * What is owed is `hasOpenInvoice()` — `OPEN_INVOICE_STATUSES`, so a
 * half-paid renewal is still open — and it is asked *first*, under the
 * subscription's own row lock. This must never become a second route by
 * which somebody who still owes money gets their service back.
 */
export async function wakeSettledIn(
    tx: Tx,
    subscriptionId: string,
    input: { reason: string; actor: Actor; at: Date },
): Promise<WakeResult> {
    const row = await lockSubscription(tx, subscriptionId);

    if (await hasOpenInvoice(tx, row.id)) {
        return { woken: false, servicesWoken: 0 };
    }

    if (row.status === "past_due") {
        // The label was true and is not any more; the services follow it.
        const back = await transitionSubscriptionIn(tx, {
            subscriptionId: row.id,
            to: "active",
            summary: `${input.reason} — wieder aktiv.`,
            actor: input.actor,
            at: input.at,
        });

        return { woken: back.changed, servicesWoken: back.servicesMoved };
    }

    /**
     * `paused` and `ended` hold their services down themselves — the pause
     * because the customer asked for it, the end because the Abo is over —
     * and money arriving undoes neither. A pause comes back through
     * `resumeSubscription`, which is the only thing that may lift it.
     *
     * Everything that is left (`cancelled`, `trialing`, `active`) leaves the
     * services alone by design (`servicesFollow`), and `applyServiceFollow`
     * is the only writer that ever sets a service `suspended` — so a
     * suspended service under one of those can only be dunning's +14 rung,
     * and its reason is gone. A hand-made Sperre, if one is ever added, will
     * need a mark of its own here.
     */
    if (row.status === "paused" || row.status === "ended") {
        return { woken: false, servicesWoken: 0 };
    }

    /**
     * The cause here is the wake itself: a service woken because the money
     * arrived is one occurrence, and a second settlement against the same
     * subscription — a half payment followed by the rest — moves no rows the
     * second time and so asks for nothing. The id is the event recorded
     * below.
     */
    const wakeEventId = createId("subscriptionevent");

    const servicesWoken = (
        await applyServiceFollow(tx, row.id, "active", input.at, wakeEventId)
    ).length;

    if (servicesWoken === 0) {
        return { woken: false, servicesWoken: 0 };
    }

    await recordEvent(tx, {
        id: wakeEventId,
        subscriptionId: row.id,
        kind: "dunning",
        summary: `${input.reason} — Leistungen wieder freigeschaltet.`,
        data: { servicesWoken, status: row.status },
        actor: input.actor,
        at: input.at,
    });

    await audit(tx, {
        actor: input.actor,
        action: "subscription.reactivate",
        entityType: "subscription",
        entityId: row.id,
        before: { status: row.status, services: "suspended" },
        after: { status: row.status, services: "active", servicesWoken },
    });

    return { woken: true, servicesWoken };
}

/**
 * Brings a subscription back once everything it owes has been settled —
 * the mirror of dunning, and the reason a customer who pays at midnight has
 * their server back at one minute past.
 *
 * It is called from two places and both are deliberate: `emitInvoicePaid`,
 * which is the seam every settled payment passes through, and the daily run,
 * which catches anything a failed mail or a crashed process dropped. Both end
 * in `wakeSettledIn`, so there is one rule about what "paid up" means.
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
        const back = await db.transaction(async (tx) =>
            wakeSettledIn(tx, link.subscriptionId, {
                reason: "Zahlung eingegangen",
                actor,
                at,
            }),
        );

        if (back.woken) {
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

/**
 * Whether dunning is holding this subscription's services down.
 *
 * The one thing that tells a Sperre wegen Zahlungsverzugs apart from a pause
 * the customer asked for, which are the same `suspended` service status: the
 * `dunning_action` row the suspension rung claimed, against an invoice that
 * **still wants money**. `OPEN_INVOICE_STATUSES` again rather than a literal
 * (rule 3) — a renewal half paid is not paid, and the rung's row stays
 * claimed for ever, so the invoice is what says whether the hold is still
 * warranted.
 *
 * It is deliberately *not* "is anything open": an invoice inside its grace,
 * before the rung, has suspended nothing, and leaving a service down for it
 * would take away exactly the days dunning is supposed to give.
 */
export async function hasDunningSuspension(
    tx: Tx,
    subscriptionId: string,
): Promise<boolean> {
    const [held] = await tx
        .select({ id: schema.dunningAction.id })
        .from(schema.subscriptionInvoice)
        .innerJoin(
            schema.invoice,
            eq(schema.subscriptionInvoice.invoiceId, schema.invoice.id),
        )
        .innerJoin(
            schema.dunningAction,
            and(
                eq(schema.dunningAction.invoiceId, schema.invoice.id),
                eq(schema.dunningAction.level, "suspend"),
            ),
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

    return Boolean(held);
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
