import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { add } from "@/lib/money";
import type { Actor } from "@/server/audit";
import { createCreditNoteIn } from "@/server/billing/invoices/service";
import { precedingPeriod } from "@/server/billing/periods";
import { loadSettings, type Settings } from "@/server/settings";
import {
    hasOpenInvoice,
    lockSubscription,
    recordEvent,
    SubscriptionError,
    transitionSubscriptionIn,
} from "@/server/subscriptions/service";

/**
 * The way back.
 *
 * Every rule in this phase that moves something forward has a counterpart
 * here that moves it back, and each of them is written as the *same*
 * operation with its sign reversed rather than as a second mechanism:
 *
 *  - a renewal invoice is raised → `cancelRenewalInvoice` credits it, gives
 *    the coupon period back and rolls the billing period back by
 *    `precedingPeriod`, which is `followingPeriod` read backwards;
 *  - a Mahngebühr is raised → `waiveDunningFee` credits that invoice and
 *    marks the rung's fee withdrawn.
 *
 * Phase 5 shipped a refund path that credited the balance on the way in and
 * never debited it on the way out, and a refunded top-up paid out twice.
 * This file is where that lesson is kept for Phase 6: a rule written in one
 * direction is half a rule.
 *
 * Both of them are one transaction. A credit note without the subscription
 * being put back is a customer who owes nothing and is still suspended; a
 * subscription put back without the credit note is a document that no longer
 * matches the books.
 */

type Db = typeof defaultDb;

export type ReversalResult = {
    creditNoteId: string;
    creditNoteNumber: string;
    grossCents: number;
    /** The subscriptions whose period was put back. */
    rolledBack: string[];
};

/**
 * Takes a renewal invoice back, in full.
 *
 * What it undoes, each the mirror of what `issueRenewals` did:
 *
 *  1. the document — a Rechnungskorrektur over everything that is left of
 *     it, through `createCreditNoteIn`, so there is no second way for an
 *     invoice to stop standing;
 *  2. the link — removed, so the next pass may raise a fresh invoice for
 *     the same period. That is almost always why an operator is here: the
 *     amount was wrong and a correct one is wanted;
 *  3. the coupon period the renewal consumed — given back, because the
 *     period it was granted for is no longer billed;
 *  4. the billing period, where it had already advanced into the one this
 *     invoice bought — rolled back to where it was.
 *
 * A fee invoice or an immediate plan-change invoice is **not** a renewal and
 * is refused here: both are documents about something that actually
 * happened, and crediting them is `waiveDunningFee` or an ordinary
 * correction in the admin area.
 */
export async function cancelRenewalInvoice(
    db: Db,
    input: {
        invoiceId: string;
        reason?: string | null;
        actor: Actor;
        now?: Date;
        settings?: Settings;
    },
): Promise<ReversalResult> {
    const at = input.now ?? new Date();
    const settings = input.settings ?? (await loadSettings());

    return db.transaction(async (tx) => {
        const links = await tx
            .select()
            .from(schema.subscriptionInvoice)
            .where(
                and(
                    eq(schema.subscriptionInvoice.invoiceId, input.invoiceId),
                    eq(schema.subscriptionInvoice.kind, "renewal"),
                ),
            )
            .orderBy(asc(schema.subscriptionInvoice.subscriptionId));

        if (links.length === 0) {
            throw new SubscriptionError(
                "not-found",
                "Diese Rechnung ist keine Verlängerung.",
            );
        }

        const credited = await createCreditNoteIn(
            tx,
            {
                invoiceId: input.invoiceId,
                kind: "full",
                reason: input.reason?.trim() || "Verlängerung zurückgenommen.",
            },
            input.actor,
            { at, settings },
        );

        const rolledBack: string[] = [];

        for (const link of links) {
            const row = await lockSubscription(tx, link.subscriptionId);

            /**
             * The period the invoice bought. If the subscription has already
             * moved into it, it goes back to the one before — computed by
             * `precedingPeriod`, the exact inverse of the `followingPeriod`
             * that moved it forward, so the two cannot land a day apart.
             */
            if (
                row.currentPeriodStart.getTime() === link.periodStart.getTime()
            ) {
                const previous = precedingPeriod(link.periodStart, row.cycle);

                await tx
                    .update(schema.subscription)
                    .set({
                        currentPeriodStart: previous.start,
                        currentPeriodEnd: link.periodStart,
                        nextBillingAt: link.periodStart,
                        updatedAt: at,
                    })
                    .where(eq(schema.subscription.id, row.id));

                rolledBack.push(row.id);
            } else if (row.nextBillingAt === null) {
                // It had not advanced but the date had been cleared (an
                // ended or paused Abo). Put the billing date back where the
                // invoice says it belongs, so a fresh one can be raised.
                await tx
                    .update(schema.subscription)
                    .set({ nextBillingAt: link.periodStart, updatedAt: at })
                    .where(eq(schema.subscription.id, row.id));
            }

            /**
             * The coupon period this renewal consumed, given back. `null`
             * means the discount runs for ever and there is nothing to
             * count; `consumeDiscountPeriod` floors at zero, so the way back
             * simply adds one.
             */
            if (row.discountPeriodsRemaining !== null) {
                await tx
                    .update(schema.subscription)
                    .set({
                        discountPeriodsRemaining: add(
                            row.discountPeriodsRemaining,
                            1,
                        ),
                        updatedAt: at,
                    })
                    .where(eq(schema.subscription.id, row.id));
            }

            await tx
                .delete(schema.subscriptionInvoice)
                .where(eq(schema.subscriptionInvoice.id, link.id));

            await recordEvent(tx, {
                subscriptionId: row.id,
                kind: "period",
                summary: `Verlängerung zurückgenommen — Korrektur ${credited.number}.`,
                data: {
                    invoiceId: input.invoiceId,
                    creditNoteNumber: credited.number,
                    periodStart: link.periodStart.toISOString(),
                },
                actor: input.actor,
                at,
            });

            // Nothing is owed on it any more, so an Abo that was only
            // past_due because of it comes back — the same rule the payment
            // seam applies, applied to the other way of owing nothing.
            if (
                row.status === "past_due" &&
                !(await hasOpenInvoice(tx, row.id))
            ) {
                await transitionSubscriptionIn(tx, {
                    subscriptionId: row.id,
                    to: "active",
                    summary: "Nichts mehr offen — wieder aktiv.",
                    actor: input.actor,
                    at,
                });
            }
        }

        return {
            creditNoteId: credited.id,
            creditNoteNumber: credited.number,
            grossCents: credited.totals.grossCents,
            rolledBack,
        };
    });
}

/**
 * Withdraws a Mahngebühr.
 *
 * The fee was its own invoice (rule 3: the invoice it belongs to cannot grow
 * a line), so taking it back is a Rechnungskorrektur over that invoice —
 * the same documents, in the opposite direction. The rung itself stays
 * claimed: the Mahnung *was* sent, and pretending otherwise would let the
 * run send it again.
 */
export async function waiveDunningFee(
    db: Db,
    input: {
        dunningActionId: string;
        reason?: string | null;
        actor: Actor;
        now?: Date;
        settings?: Settings;
    },
): Promise<ReversalResult> {
    const at = input.now ?? new Date();
    const settings = input.settings ?? (await loadSettings());

    return db.transaction(async (tx) => {
        const [action] = await tx
            .select()
            .from(schema.dunningAction)
            .where(eq(schema.dunningAction.id, input.dunningActionId))
            .for("update");

        if (!action?.feeInvoiceId) {
            throw new SubscriptionError(
                "not-found",
                "Zu dieser Mahnung gibt es keine Gebührenrechnung.",
            );
        }

        if (action.feeWaivedAt) {
            throw new SubscriptionError(
                "not-found",
                "Diese Mahngebühr wurde bereits zurückgenommen.",
            );
        }

        const credited = await createCreditNoteIn(
            tx,
            {
                invoiceId: action.feeInvoiceId,
                kind: "full",
                reason: input.reason?.trim() || "Mahngebühr erlassen.",
            },
            input.actor,
            { at, settings },
        );

        await tx
            .update(schema.dunningAction)
            .set({ feeWaivedAt: at, updatedAt: at })
            .where(eq(schema.dunningAction.id, action.id));

        return {
            creditNoteId: credited.id,
            creditNoteNumber: credited.number,
            grossCents: credited.totals.grossCents,
            rolledBack: [],
        };
    });
}
