import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { subtract } from "@/lib/money";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { isOpenInvoice, type PaymentProvider } from "@/db/schema";
import { receivedFrom, settlementFor } from "./settlement";

/**
 * `applyPayment` — the one place money meets a document.
 *
 * Every way of being paid ends here: a Stripe webhook, a PayPal capture, the
 * customer's own return from a hosted page, a transfer somebody booked by
 * hand, credit being spent. One path, because two paths is how an invoice
 * gets settled twice by mechanisms that do not know about each other.
 *
 * Three things make it safe to run again, and all three are in the database
 * rather than in a caller's good intentions:
 *
 *  1. The transaction's first statement takes the payment row **`FOR
 *     UPDATE`**, keyed on the provider's reference, which is unique. A second
 *     delivery of the same event, a retried capture and a double-clicked
 *     button all queue behind the first and then find it already succeeded.
 *  2. What has been received is **summed from the rows**, never incremented.
 *     An increment applied twice is simply wrong; a row written twice cannot
 *     happen, because of (1), and would be visible if it did.
 *  3. The overpayment entry is keyed on the payment, by a unique index. Even
 *     if everything above failed, the customer's balance could not double.
 *
 * It never recomputes what is owed. `invoice.gross_cents` is what
 * `calculateTotals()` froze at finalization; `credited_cents` is what the
 * Rechnungskorrekturen took back. A payment reads those two.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export type ApplyPaymentInput = {
    /**
     * The provider's reference, and the idempotency key: a Checkout Session,
     * a PayPal order, a refund id, or the token a hand-booking form carried.
     */
    ref: string;
    gateway: PaymentProvider;
    /**
     * Required when no attempt has been recorded under `ref` yet — a manual
     * booking, or credit being spent. A webhook leaves it unset and is told
     * `known: false` if it names nothing we started, which is the whole point:
     * an unverified payload must never be able to name the invoice it settles.
     */
    invoiceId?: string | null;
    customerId?: string | null;
    /**
     * The provider's own minor-unit integer, where it reports one. It wins
     * over what we recorded — that is the money that actually moved — and a
     * difference is reported rather than smoothed over.
     */
    amountCents?: number | null;
    captureRef?: string | null;
    feeCents?: number | null;
    paymentMethodId?: string | null;
    note?: string | null;
    purpose?: "invoice" | "topup";
    at?: Date;
    actor: Actor;
};

export type ApplyOutcome = {
    /** We recognised the reference, or were given enough to create it. */
    known: boolean;
    /** State actually moved. False on a repeat delivery. */
    changed: boolean;
    paymentId: string | null;
    invoiceId: string | null;
    invoiceNumber: string | null;
    customerId: string | null;
    /** The invoice's status after this payment. */
    invoiceStatus: string | null;
    /** What this payment was worth. */
    amountCents: number;
    paidCents: number;
    outstandingCents: number;
    /** What this payment added to the customer's balance. */
    creditedToBalanceCents: number;
    /** The invoice was not waiting for money: cancelled, or already paid. */
    unexpected: boolean;
    /** The provider said one figure and we had recorded another. */
    amountMismatch: { recorded: number; reported: number } | null;
    /** Where a receipt goes, when one is owed. */
    receiptTo: string | null;
};

function nothing(known = false): ApplyOutcome {
    return {
        known,
        changed: false,
        paymentId: null,
        invoiceId: null,
        invoiceNumber: null,
        customerId: null,
        invoiceStatus: null,
        amountCents: 0,
        paidCents: 0,
        outstandingCents: 0,
        creditedToBalanceCents: 0,
        unexpected: false,
        amountMismatch: null,
        receiptTo: null,
    };
}

export async function applyPayment(
    db: Db,
    input: ApplyPaymentInput,
): Promise<ApplyOutcome> {
    return db.transaction((tx) => applyPaymentIn(tx, input));
}

/**
 * The body, with the transaction handed in — so a caller that is already
 * inside one (the checkout settling a transfer, say) has no second path to
 * reach for. Same shape as `finalizeInvoiceIn`, for the same reason.
 */
export async function applyPaymentIn(
    tx: Tx,
    input: ApplyPaymentInput,
): Promise<ApplyOutcome> {
    const at = input.at ?? new Date();

    // (1) The lock. Everything below reads what this row and the invoice say,
    // so nothing may move underneath it. `provider_ref` is unique across the
    // table, which is what lets a webhook find its own attempt by reference
    // alone.
    const [existing] = await tx
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.providerRef, input.ref))
        .for("update");

    if (existing && existing.provider !== input.gateway) {
        // The same reference under a different gateway is not our row. Saying
        // nothing would let one provider's id settle another's payment.
        return nothing(false);
    }

    if (existing?.status === "succeeded") {
        // Already done. The common case for a webhook, and the reason this
        // function can be called by three things at once.
        return {
            ...nothing(true),
            paymentId: existing.id,
            invoiceId: existing.invoiceId,
            customerId: existing.customerId,
            amountCents: existing.amountCents,
        };
    }

    const purpose = input.purpose ?? existing?.purpose ?? "invoice";
    const invoiceId = existing?.invoiceId ?? input.invoiceId ?? null;
    const customerId = existing?.customerId ?? input.customerId ?? null;

    if (!customerId) {
        return nothing(false);
    }

    if (purpose === "invoice" && !invoiceId) {
        return nothing(false);
    }

    // The amount that actually moved. The provider's figure wins; where it
    // reports none, the attempt we recorded stands.
    const recorded = existing?.amountCents ?? null;
    const reported = input.amountCents ?? null;
    const amountCents = reported ?? recorded;

    if (amountCents === null || !Number.isSafeInteger(amountCents)) {
        return nothing(false);
    }

    const amountMismatch =
        recorded !== null && reported !== null && recorded !== reported
            ? { recorded, reported }
            : null;

    const paymentId = existing?.id ?? createId("payment");

    if (existing) {
        await tx
            .update(schema.payment)
            .set({
                status: "succeeded",
                amountCents,
                captureRef: input.captureRef ?? existing.captureRef,
                feeCents: input.feeCents ?? existing.feeCents,
                paymentMethodId:
                    input.paymentMethodId ?? existing.paymentMethodId,
                note: input.note ?? existing.note,
                failureCode: null,
                failureMessage: null,
                settledAt: at,
                updatedAt: at,
            })
            .where(eq(schema.payment.id, existing.id));
    } else {
        await tx.insert(schema.payment).values({
            id: paymentId,
            invoiceId,
            customerId,
            provider: input.gateway,
            status: "succeeded",
            kind: "charge",
            purpose,
            paymentMethodId: input.paymentMethodId ?? null,
            amountCents,
            providerRef: input.ref,
            captureRef: input.captureRef ?? null,
            feeCents: input.feeCents ?? null,
            note: input.note ?? null,
            settledAt: at,
            createdAt: at,
            updatedAt: at,
        });
    }

    if (purpose === "topup" || !invoiceId) {
        // Money with no document behind it: it buys credit and nothing else.
        await creditBalance(tx, {
            paymentId,
            customerId,
            invoiceId: null,
            kind: "topup",
            amountCents,
            reason: "Guthaben aufgeladen",
        });

        await audit(tx, {
            actor: input.actor,
            action: "payment.apply",
            entityType: "payment",
            entityId: paymentId,
            after: {
                gateway: input.gateway,
                purpose: "topup",
                amountCents,
                ref: input.ref,
            },
        });

        return {
            ...nothing(true),
            changed: true,
            paymentId,
            customerId,
            amountCents,
            creditedToBalanceCents: amountCents,
            amountMismatch,
        };
    }

    return settleAgainstInvoice(tx, {
        at,
        actor: input.actor,
        gateway: input.gateway,
        ref: input.ref,
        paymentId,
        invoiceId,
        customerId,
        amountCents,
        amountMismatch,
    });
}

async function settleAgainstInvoice(
    tx: Tx,
    context: {
        at: Date;
        actor: Actor;
        gateway: PaymentProvider;
        ref: string;
        paymentId: string;
        invoiceId: string;
        customerId: string;
        amountCents: number;
        amountMismatch: { recorded: number; reported: number } | null;
    },
): Promise<ApplyOutcome> {
    const { at, invoiceId, paymentId } = context;

    const [invoice] = await tx
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId))
        .for("update");

    if (!invoice) {
        return nothing(false);
    }

    if (invoice.customerId !== context.customerId) {
        // The attempt and the invoice disagree about whose money this is.
        // Nothing is booked; somebody has to look at it.
        return nothing(false);
    }

    /**
     * A draft has no number, no legal existence and no frozen total — its
     * `gross_cents` is null — so there is nothing to settle against. Every
     * caller already refuses one, and the immutability trigger lets anything
     * through on a draft, which is exactly why the last line of defence
     * belongs here rather than only in them.
     */
    if (invoice.status === "draft" || invoice.grossCents === null) {
        return nothing(false);
    }

    // (2) Summed, never incremented — and read *after* the payment row above
    // was written, so this payment is part of the sum. `before` is the same
    // sum without it, which is what says how much of the overshoot is this
    // payment's doing.
    const movements = await movementsFor(tx, invoiceId);
    const received = receivedFrom(movements);
    const before = receivedFrom(
        movements.filter((row) => row.id !== paymentId),
    );

    const settlement = settlementFor({
        grossCents: invoice.grossCents ?? 0,
        creditedCents: invoice.creditedCents,
        receivedCents: received,
    });

    const previous = settlementFor({
        grossCents: invoice.grossCents ?? 0,
        creditedCents: invoice.creditedCents,
        receivedCents: before,
    });

    /**
     * Only what *this* payment added beyond what was owed. Two payments that
     * overshoot by 5 and then by 3 leave the customer with 8, in two entries
     * that each name the payment they came from.
     */
    const creditedToBalanceCents = subtract(
        settlement.overpaymentCents,
        previous.overpaymentCents,
    );

    // A document that has been corrected away keeps the status it has: what a
    // payment against it means is a decision, and § 8 leaves those to the
    // operator. The money is still recorded, and it still becomes credit.
    const keepStatus = invoice.status === "cancelled";
    const unexpected = keepStatus || previous.status === "paid";

    const status = keepStatus ? invoice.status : settlement.status;

    await tx
        .update(schema.invoice)
        .set({
            status,
            paidCents: settlement.paidCents,
            paidAt: status === "paid" ? (invoice.paidAt ?? at) : null,
            updatedAt: at,
        })
        .where(eq(schema.invoice.id, invoiceId));

    if (creditedToBalanceCents !== 0) {
        await creditBalance(tx, {
            paymentId,
            customerId: invoice.customerId,
            invoiceId,
            kind: "overpayment",
            amountCents: creditedToBalanceCents,
            reason:
                creditedToBalanceCents > 0
                    ? `Überzahlung zu Rechnung ${invoice.number ?? invoiceId}`
                    : `Rücknahme einer Überzahlung zu Rechnung ${invoice.number ?? invoiceId}`,
        });
    }

    await audit(tx, {
        actor: context.actor,
        action: "payment.apply",
        entityType: "invoice",
        entityId: invoiceId,
        before: {
            status: invoice.status,
            paidCents: invoice.paidCents,
        },
        after: {
            status,
            paidCents: settlement.paidCents,
            paymentId,
            gateway: context.gateway,
            // The provider's reference, not its credentials. Nothing secret
            // reaches the log.
            ref: context.ref,
            amountCents: context.amountCents,
            creditedToBalanceCents,
        },
    });

    return {
        known: true,
        changed: true,
        paymentId,
        invoiceId,
        invoiceNumber: invoice.number,
        customerId: invoice.customerId,
        invoiceStatus: status,
        amountCents: context.amountCents,
        paidCents: settlement.paidCents,
        outstandingCents: settlement.outstandingCents,
        creditedToBalanceCents,
        unexpected,
        amountMismatch: context.amountMismatch,
        /**
         * A receipt is owed for a part payment too: the customer handed over
         * money and is entitled to hear that it arrived — and, more to the
         * point, to hear what is still open before the invoice goes overdue.
         * The frozen address when the invoice has one, so the receipt follows
         * the document rather than a since-changed account.
         */
        receiptTo: keepStatus
            ? null
            : (invoice.buyerEmail ??
              (await ownerEmail(tx, invoice.customerId))),
    };
}

/** Every movement of money against one invoice, in the order it happened. */
async function movementsFor(tx: Executor, invoiceId: string) {
    return tx
        .select({
            id: schema.payment.id,
            kind: schema.payment.kind,
            status: schema.payment.status,
            amountCents: schema.payment.amountCents,
        })
        .from(schema.payment)
        .where(eq(schema.payment.invoiceId, invoiceId))
        .orderBy(asc(schema.payment.id));
}

/**
 * (3) The last guard. The unique index on `(payment_id, kind)` means a second
 * attempt to credit the same payment is a no-op rather than a doubled
 * balance, whatever went wrong further up.
 */
async function creditBalance(
    tx: Tx,
    entry: {
        paymentId: string;
        customerId: string;
        invoiceId: string | null;
        kind: "overpayment" | "topup" | "applied" | "refund" | "adjustment";
        amountCents: number;
        reason: string;
    },
) {
    await tx
        .insert(schema.creditLedger)
        .values({
            id: createId("creditledger"),
            customerId: entry.customerId,
            kind: entry.kind,
            amountCents: entry.amountCents,
            paymentId: entry.paymentId,
            invoiceId: entry.invoiceId,
            reason: entry.reason,
        })
        .onConflictDoNothing();
}

/** The account's owner, for a receipt when the invoice froze no address. */
async function ownerEmail(tx: Executor, customerId: string) {
    const [row] = await tx
        .select({ email: schema.customerContact.email })
        .from(schema.customerContact)
        .where(eq(schema.customerContact.customerId, customerId))
        .orderBy(
            sql`case when ${schema.customerContact.role} = 'owner' then 0 else 1 end`,
            asc(schema.customerContact.id),
        )
        .limit(1);

    return row?.email ?? null;
}

/**
 * The customer's balance: the ledger, added up. No column holds it, so it
 * cannot drift from the entries that explain it.
 */
export async function creditBalanceCents(
    executor: Executor,
    customerId: string,
): Promise<number> {
    const [row] = await executor
        .select({
            cents: sql<number>`coalesce(sum(${schema.creditLedger.amountCents}), 0)::int`,
        })
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.customerId, customerId));

    return row?.cents ?? 0;
}

/**
 * Spends credit on an open invoice.
 *
 * It is a payment like any other — same table, same settlement, same audit —
 * so that an invoice paid half from a card and half from the balance adds up
 * in one place. The ledger entry is written in the same transaction, under
 * the customer's row lock, so two tabs cannot spend the same euro twice.
 */
export async function payFromCredit(
    db: Db,
    input: {
        invoiceId: string;
        customerId: string;
        amountCents: number;
        actor: Actor;
        at?: Date;
    },
): Promise<ApplyOutcome & { reason?: string }> {
    const at = input.at ?? new Date();

    return db.transaction(async (tx) => {
        // The balance is read under a lock on the customer, which every other
        // spend also takes: without it two tabs each see the same euro.
        await tx
            .select({ id: schema.customer.id })
            .from(schema.customer)
            .where(eq(schema.customer.id, input.customerId))
            .for("update");

        // Checked before a single row is written: the ledger entry below is
        // the customer's money leaving their balance, and it may not survive
        // a settlement that then refuses the invoice.
        const [invoice] = await tx
            .select({
                customerId: schema.invoice.customerId,
                status: schema.invoice.status,
                grossCents: schema.invoice.grossCents,
                creditedCents: schema.invoice.creditedCents,
                paidCents: schema.invoice.paidCents,
            })
            .from(schema.invoice)
            .where(eq(schema.invoice.id, input.invoiceId))
            .for("update");

        if (
            !invoice ||
            invoice.customerId !== input.customerId ||
            !isOpenInvoice(invoice.status)
        ) {
            return {
                ...nothing(false),
                reason: "Diese Rechnung kann nicht bezahlt werden.",
            };
        }

        const outstanding = subtract(
            Math.max(
                subtract(invoice.grossCents ?? 0, invoice.creditedCents),
                0,
            ),
            invoice.paidCents,
        );

        const balance = await creditBalanceCents(tx, input.customerId);

        if (input.amountCents <= 0 || balance < input.amountCents) {
            return {
                ...nothing(false),
                reason: "Das Guthaben reicht dafür nicht aus.",
            };
        }

        // Spending more than is owed would hand the overshoot straight back
        // as credit, which is a loop rather than a payment.
        if (input.amountCents > outstanding) {
            return {
                ...nothing(false),
                reason: "Es kann höchstens der offene Betrag angerechnet werden.",
            };
        }

        const paymentId = createId("payment");

        // The payment row first: the ledger entry points at it, so the other
        // order fails the foreign key — which is the database saying the same
        // thing as the comment.
        await tx.insert(schema.payment).values({
            id: paymentId,
            invoiceId: input.invoiceId,
            customerId: input.customerId,
            provider: "credit",
            status: "pending",
            kind: "charge",
            purpose: "invoice",
            amountCents: input.amountCents,
            providerRef: `credit:${paymentId}`,
            settledAt: null,
            createdAt: at,
            updatedAt: at,
        });

        await tx.insert(schema.creditLedger).values({
            id: createId("creditledger"),
            customerId: input.customerId,
            kind: "applied",
            amountCents: -input.amountCents,
            paymentId,
            invoiceId: input.invoiceId,
            reason: "Guthaben auf eine Rechnung angerechnet",
        });

        return applyPaymentIn(tx, {
            ref: `credit:${paymentId}`,
            gateway: "credit",
            invoiceId: input.invoiceId,
            customerId: input.customerId,
            amountCents: input.amountCents,
            actor: input.actor,
            at,
        });
    });
}

/**
 * Books credit by hand — a goodwill adjustment, or paying a balance back out.
 * Staff only; the caller does the permission check.
 */
export async function adjustCredit(
    db: Db,
    input: {
        customerId: string;
        amountCents: number;
        reason: string;
        actor: Actor;
    },
): Promise<{ ok: boolean; balanceCents: number }> {
    return db.transaction(async (tx) => {
        await tx
            .select({ id: schema.customer.id })
            .from(schema.customer)
            .where(eq(schema.customer.id, input.customerId))
            .for("update");

        const balance = await creditBalanceCents(tx, input.customerId);

        if (balance + input.amountCents < 0) {
            return { ok: false, balanceCents: balance };
        }

        await tx.insert(schema.creditLedger).values({
            id: createId("creditledger"),
            customerId: input.customerId,
            kind: "adjustment",
            amountCents: input.amountCents,
            reason: input.reason,
        });

        await audit(tx, {
            actor: input.actor,
            action: "credit.adjust",
            entityType: "customer",
            entityId: input.customerId,
            before: { balanceCents: balance },
            after: {
                balanceCents: balance + input.amountCents,
                amountCents: input.amountCents,
                reason: input.reason,
            },
        });

        return { ok: true, balanceCents: balance + input.amountCents };
    });
}

/** The entries behind a balance, newest first. */
export async function listCreditLedger(
    executor: Executor,
    customerId: string,
    limit = 100,
) {
    return executor
        .select()
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.customerId, customerId))
        .orderBy(sql`${schema.creditLedger.id} desc`)
        .limit(limit);
}

/** Used by the refund path to re-settle an invoice after money went back. */
export async function resettleInvoice(
    tx: Tx,
    invoiceId: string,
    at: Date,
): Promise<{ status: string; paidCents: number } | null> {
    const [invoice] = await tx
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId))
        .for("update");

    if (!invoice) {
        return null;
    }

    const settlement = settlementFor({
        grossCents: invoice.grossCents ?? 0,
        creditedCents: invoice.creditedCents,
        receivedCents: receivedFrom(await movementsFor(tx, invoiceId)),
    });

    // A corrected-away invoice keeps its status; everything else follows the
    // money. An invoice can go from `paid` back to `partial` or `unpaid` —
    // that is what a refund means — but never back to `draft`, which the
    // trigger refuses outright.
    const status =
        invoice.status === "cancelled" ? invoice.status : settlement.status;

    await tx
        .update(schema.invoice)
        .set({
            status,
            paidCents: settlement.paidCents,
            paidAt: status === "paid" ? (invoice.paidAt ?? at) : null,
            updatedAt: at,
        })
        .where(eq(schema.invoice.id, invoiceId));

    return { status, paidCents: settlement.paidCents };
}

/** Everything settled against one invoice, for the detail pages. */
export async function paymentsForInvoice(
    executor: Executor,
    invoiceId: string,
) {
    return executor
        .select()
        .from(schema.payment)
        .where(
            and(
                eq(schema.payment.invoiceId, invoiceId),
                sql`${schema.payment.status} <> 'failed'`,
            ),
        )
        .orderBy(asc(schema.payment.id));
}
