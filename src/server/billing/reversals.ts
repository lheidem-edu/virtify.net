import "server-only";
import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { add, subtract } from "@/lib/money";
import type { Actor } from "@/server/audit";
import { creditedQuantities } from "@/server/billing/invoices/repository";
import { createCreditNoteIn } from "@/server/billing/invoices/service";
import { precedingPeriod } from "@/server/billing/periods";
import { recordRefundIn } from "@/server/payments/refunds";
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
 *  - the run spends the balance on it → the `credit` charge is reversed by
 *    `recordRefundIn`, the very path a refund takes, so the euros go back
 *    where they came from instead of standing as an unattributed
 *    overpayment on a cancelled document;
 *  - a renewal is raised ahead and the Abo is then cancelled before that
 *    period → `cancelUndeliveredRenewalsIn` is that same reversal, in the
 *    cancellation's own transaction;
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
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ReversalResult = {
    creditNoteId: string;
    creditNoteNumber: string;
    grossCents: number;
    /** What the correction freed and put on the customer's balance. */
    /** The subscriptions whose period was put back. */
    rolledBack: string[];
    /** What of it had been paid from the balance and went back there. */
    creditReturnedCents: number;
};

/**
 * Gives back whatever of this document was paid from the customer's balance.
 *
 * The run spends the balance on a renewal by itself — `applyCreditToInvoice`
 * → `payFromCredit` — and that is a `credit` charge like any other, so
 * taking the document back has to reverse that charge like any other: a
 * refund row, `reverseChargeCredit` putting the ledger entry back with its
 * sign turned round, and `resettleInvoice` taking the money off the invoice.
 * The same machinery `refunds.ts` uses, rather than a second one; a rule
 * written only on the way in is half a rule, and this half used to be
 * missing — the balance stayed spent on a cancelled document and the next
 * pass spent 19,99 € of it a second time on the corrected renewal.
 *
 * **Before the Rechnungskorrektur, deliberately.** The refund is arithmetic
 * over what the invoice still asks for, and `bookOvershootDelta` compares
 * the document with and without this row: run after the correction has taken
 * the whole of it back, the same 19,99 € would read as an overpayment being
 * withdrawn and the give-back would cancel itself out to nothing.
 *
 * Real money is left alone. A card or a transfer stays recorded against the
 * cancelled document until the operator refunds it through `refunds.ts` —
 * that is a decision with a bank behind it, not a bookkeeping entry.
 *
 * Twice is a no-op in two places: the refund row carries a reference derived
 * from the charge, which is unique, and every ledger entry is keyed on
 * `(payment_id, kind)`.
 */
async function returnCreditSpentOn(
    tx: Tx,
    input: {
        invoiceId: string;
        reason: string;
        actor: Actor;
        at: Date;
    },
): Promise<number> {
    const spent = await tx
        .select()
        .from(schema.payment)
        .where(
            and(
                eq(schema.payment.invoiceId, input.invoiceId),
                eq(schema.payment.provider, "credit"),
                eq(schema.payment.kind, "charge"),
                eq(schema.payment.status, "succeeded"),
            ),
        )
        .orderBy(asc(schema.payment.id));

    let returned = 0;

    for (const charge of spent) {
        const refundable = subtract(charge.amountCents, charge.refundedCents);

        if (refundable <= 0) {
            continue;
        }

        const result = await recordRefundIn(tx, {
            chargePaymentId: charge.id,
            provider: "credit",
            refundRef: `credit-reversal:${charge.id}`,
            amountCents: refundable,
            reason: input.reason,
            actor: input.actor,
            at: input.at,
        });

        if (result.ok && result.changed) {
            returned = add(returned, refundable);
        }
    }

    return returned;
}

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
        /** Only this Abo's share of a grouped renewal; all of it when absent. */
        subscriptionId?: string | null;
        reason?: string | null;
        actor: Actor;
        now?: Date;
        settings?: Settings;
    },
): Promise<ReversalResult> {
    const at = input.now ?? new Date();
    const settings = input.settings ?? (await loadSettings());

    return db.transaction((tx) =>
        cancelRenewalInvoiceIn(tx, { ...input, at, settings }),
    );
}

/**
 * The same reversal inside a transaction the caller already owns.
 *
 * A cancellation needs it: the Abo's new status and the correction of the
 * renewal it will no longer get have to commit together, or a customer ends
 * up ended with the invoice still standing — which is the whole of what
 * `cancelUndeliveredRenewalsIn` is for.
 *
 * `subscriptionId` is what makes that safe on a **grouped** renewal. One
 * invoice may cover several Abos of the same customer, and taking the whole
 * document back because one of them was cancelled would cancel a renewal the
 * others are still going to be delivered. Named, only that Abo's positions
 * are corrected and only its period is put back; the document stands for the
 * rest and goes on being collected and chased for them.
 */
export async function cancelRenewalInvoiceIn(
    tx: Tx,
    input: {
        invoiceId: string;
        subscriptionId?: string | null;
        reason?: string | null;
        actor: Actor;
        at: Date;
        settings: Settings;
    },
): Promise<ReversalResult> {
    const { at, settings } = input;

    {
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

        const scoped = input.subscriptionId
            ? links.filter(
                  (link) => link.subscriptionId === input.subscriptionId,
              )
            : links;

        if (scoped.length === 0) {
            throw new SubscriptionError(
                "not-found",
                "Diese Rechnung verlängert dieses Abo nicht.",
            );
        }

        const [owner] = await tx
            .select({ customerId: schema.invoice.customerId })
            .from(schema.invoice)
            .where(eq(schema.invoice.id, input.invoiceId));

        if (!owner) {
            throw new SubscriptionError(
                "not-found",
                "Diese Rechnung gibt es nicht.",
            );
        }

        /**
         * The customer, then the document — the order `payFromCredit` takes
         * the two in. This correction may end up putting money on the
         * balance, and a spend of that balance happening at the same moment
         * would otherwise hold them the other way round and deadlock. The
         * read above takes no lock, so it cannot be the wrong half of one.
         */
        await tx
            .select({ id: schema.customer.id })
            .from(schema.customer)
            .where(eq(schema.customer.id, owner.customerId))
            .for("update");

        /**
         * Balance first, card second — and in that order for a reason.
         *
         * Two different things can have paid this renewal, and they go back
         * by two different routes. What came off the balance is reversed
         * here, through `recordRefundIn`: the Phase 5 path, keyed on the
         * charge it undoes, so a repeat is a no-op rather than a doubled
         * balance. What a card or a transfer paid stays where it is, as an
         * overpayment on the corrected document, for the operator to send
         * back — see the note below `createCreditNoteIn`.
         */
        const creditReturnedCents = await returnCreditSpentOn(tx, {
            invoiceId: input.invoiceId,
            reason: "Verlängerung zurückgenommen — angerechnetes Guthaben zurückgebucht.",
            actor: input.actor,
            at,
        });

        /**
         * The document itself, held for the rest of the transaction. Nothing
         * is read off it — `createCreditNoteIn` does its own arithmetic from
         * the rows — but a settlement arriving halfway through a correction
         * would otherwise compute what is owed against an invoice that is
         * about to stop asking for it.
         */
        const [locked] = await tx
            .select({ id: schema.invoice.id })
            .from(schema.invoice)
            .where(eq(schema.invoice.id, input.invoiceId))
            .for("update");

        if (!locked) {
            throw new SubscriptionError(
                "not-found",
                "Diese Rechnung gibt es nicht.",
            );
        }

        const credited = await createCreditNoteIn(
            tx,
            {
                invoiceId: input.invoiceId,
                ...(scoped.length === links.length
                    ? { kind: "full" as const }
                    : {
                          kind: "partial" as const,
                          lines: await shareOf(tx, input.invoiceId, scoped),
                      }),
                reason: input.reason?.trim() || "Verlängerung zurückgenommen.",
            },
            input.actor,
            { at, settings },
        );

        /**
         * What a card or a transfer paid for a period that is no longer
         * owed stays where it is — as an overpayment on the corrected
         * document — and does **not** become account credit.
         *
         * That is Phase 5's decision, not a new one: `createCreditNoteIn`
         * resettles without a `causedBy` precisely because no payment row
         * moved, and `bookOvershootDelta` books an overshoot only for the
         * payment that caused it. Turning somebody's bank transfer into a
         * voucher because we corrected a document is also the wrong default
         * in Germany — a customer owed money for a period they never got is
         * owed money, and which way it goes back (to the card, to the
         * account, to their IBAN) is the operator's call, taken through
         * `recordRefund`.
         *
         * What the *balance* paid is a different thing and has already gone
         * back, above: that one is ours to move, keyed on the charge it
         * undoes.
         */
        const rolledBack: string[] = [];

        for (const link of scoped) {
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
             * The coupon period this renewal consumed, given back — and
             * exactly that. `null` means the discount runs for ever and
             * there is nothing to count; a renewal that was charged at the
             * full price consumed nothing and gets nothing back.
             */
            if (
                row.discountPeriodsRemaining !== null &&
                (await consumedDiscountPeriod(tx, input.invoiceId, row.id))
            ) {
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
                    creditReturnedCents,
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
            creditReturnedCents,
        };
    }
}

/**
 * The positions of a grouped renewal that belong to one Abo.
 *
 * Every line `renewalLines()` builds carries the `subscription_item_id` it
 * was priced from — the discount line included — so one Abo's share of the
 * document is a join and not a guess. What earlier corrections already took
 * back is subtracted, because `createCreditNoteIn` counts what is left of a
 * position and refuses to take back more of it than was ever charged.
 */
async function shareOf(
    tx: Tx,
    invoiceId: string,
    links: { subscriptionId: string }[],
): Promise<{ invoiceItemId: string; quantity: number }[]> {
    const items = await tx
        .select({
            id: schema.invoiceItem.id,
            quantity: schema.invoiceItem.quantity,
        })
        .from(schema.invoiceItem)
        .innerJoin(
            schema.subscriptionItem,
            eq(
                schema.invoiceItem.subscriptionItemId,
                schema.subscriptionItem.id,
            ),
        )
        .where(
            and(
                eq(schema.invoiceItem.invoiceId, invoiceId),
                inArray(schema.subscriptionItem.subscriptionId, [
                    ...new Set(links.map((link) => link.subscriptionId)),
                ]),
            ),
        )
        .orderBy(asc(schema.invoiceItem.position));

    const credited = await creditedQuantities(tx, invoiceId);

    return items
        .map((item) => ({
            invoiceItemId: item.id,
            quantity: subtract(item.quantity, credited.get(item.id) ?? 0),
        }))
        .filter((line) => line.quantity !== 0);
}

/**
 * Takes back every renewal invoiced for a period this Abo will not deliver.
 *
 * A renewal is raised **ahead** of the period — a fortnight by default,
 * longer where the product asks for it — and that invoice is precisely what
 * reminds a customer to cancel. Left standing afterwards it is a demand for
 * a month in which nothing ran: the collection ladder debits the stored card
 * on the due date, and after it come a Zahlungserinnerung, a Mahnung with
 * its own Gebührenrechnung and a Kündigungsandrohung.
 *
 * So the cancellation takes it back, through the one way this project has of
 * undoing a renewal. It is not a refund of anything delivered — § 8 leaves
 * those to the operator, and this touches no period that has begun. `endsAt`
 * is the moment the Abo stops and is never read as earlier than now: the
 * grace `past_due` grants *is* service, so a period already running stays
 * invoiced and dunning may go on chasing it.
 */
export async function cancelUndeliveredRenewalsIn(
    tx: Tx,
    input: {
        subscriptionId: string;
        /** When the Abo stops: the end of the paid period, or today. */
        endsAt: Date | null;
        reason?: string | null;
        actor: Actor;
        at: Date;
        settings: Settings;
    },
): Promise<ReversalResult[]> {
    const from =
        input.endsAt && input.endsAt.getTime() > input.at.getTime()
            ? input.endsAt
            : input.at;

    const ahead = await tx
        .select({ invoiceId: schema.subscriptionInvoice.invoiceId })
        .from(schema.subscriptionInvoice)
        .innerJoin(
            schema.invoice,
            eq(schema.subscriptionInvoice.invoiceId, schema.invoice.id),
        )
        .where(
            and(
                eq(
                    schema.subscriptionInvoice.subscriptionId,
                    input.subscriptionId,
                ),
                eq(schema.subscriptionInvoice.kind, "renewal"),
                gte(schema.subscriptionInvoice.periodStart, from),
                // A document that has already been corrected away has
                // nothing left to take back.
                ne(schema.invoice.status, "cancelled"),
            ),
        )
        .orderBy(asc(schema.subscriptionInvoice.invoiceId));

    const reversed: ReversalResult[] = [];

    for (const row of ahead) {
        reversed.push(
            await cancelRenewalInvoiceIn(tx, {
                invoiceId: row.invoiceId,
                subscriptionId: input.subscriptionId,
                reason:
                    input.reason?.trim() ||
                    "Gekündigt — dieser Zeitraum wird nicht mehr geliefert.",
                actor: input.actor,
                at: input.at,
                settings: input.settings,
            }),
        );
    }

    return reversed;
}

/**
 * Did this renewal count a period off the Abo's coupon?
 *
 * The counter cannot answer it. `consumeDiscountPeriod` floors at zero, so
 * an Abo whose periods are spent reads 0 before the renewal and 0 after it
 * — indistinguishable from one that stood at 1 and was counted down. Adding
 * one back regardless hands out a discounted period that was never agreed,
 * and hands out another on every further correction, until an operator
 * fixing an unrelated mistake has given the customer a permanent discount.
 *
 * The invoice is where the answer is kept, because the invoice is where the
 * discount was granted: `renewalLines` puts the coupon on a line of its own,
 * against the Abo position it belongs to and at a negative amount, and a
 * renewal priced at the full price carries no such line. One is still one
 * however many positions the Abo has — the period is counted off per
 * renewal, not per line.
 */
async function consumedDiscountPeriod(
    tx: Tx,
    invoiceId: string,
    subscriptionId: string,
): Promise<boolean> {
    const [discount] = await tx
        .select({ id: schema.invoiceItem.id })
        .from(schema.invoiceItem)
        .innerJoin(
            schema.subscriptionItem,
            eq(
                schema.invoiceItem.subscriptionItemId,
                schema.subscriptionItem.id,
            ),
        )
        .where(
            and(
                eq(schema.invoiceItem.invoiceId, invoiceId),
                eq(schema.subscriptionItem.subscriptionId, subscriptionId),
                lt(schema.invoiceItem.unitPriceCents, 0),
            ),
        )
        .limit(1);

    return discount !== undefined;
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

        // A Mahngebühr can have been settled from the balance too — by the
        // customer's own "Guthaben anrechnen" — and erlassen means erlassen:
        // the same give-back, through the same machinery.
        const creditReturnedCents = await returnCreditSpentOn(tx, {
            invoiceId: action.feeInvoiceId,
            reason: "Mahngebühr erlassen — angerechnetes Guthaben zurückgebucht.",
            actor: input.actor,
            at,
        });

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
            creditReturnedCents,
        };
    });
}
