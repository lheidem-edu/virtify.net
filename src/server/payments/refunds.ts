import "server-only";
import { and, count, eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { PaymentProvider } from "@/db/schema";
import { add, subtract } from "@/lib/money";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { resettleInvoice, reverseChargeCredit } from "./apply";
import { gatewayFor } from "./gateways";

/**
 * Money going back out.
 *
 * Two rules shape this file, and both come from rule 3.
 *
 * **A refund is never an edit of the invoice.** The document said what it
 * said; what changes is how much has been received against it. The paper
 * correction is a Rechnungskorrektur, issued by
 * `billing/invoices/service.ts` — this module moves the money and nothing
 * else. The admin flow does both, correction first: a correction without a
 * refund is an operator who still owes the customer money, which is visible;
 * a refund without a correction is a document that no longer matches the
 * books, which is not.
 *
 * **A refund is a row, not a status.** `kind = 'refund'`, pointing at the
 * charge it reverses, with its own amount — so a charge refunded twice in
 * part is two rows that add up, and `receivedFrom()` keeps working without
 * knowing anything about refunds except their sign.
 *
 * Idempotency is the provider's own refund id in `provider_ref`, which is
 * unique. A `charge.refunded` delivered twice, and a refund the admin area
 * made that the provider then also reports, insert once between them.
 */

type Db = typeof defaultDb;

export type RefundResult =
    | { ok: true; changed: boolean; refundPaymentId: string | null }
    | { ok: false; reason: string };

/**
 * Writes a refund that has already happened at the provider. The webhook path
 * and the admin path both end here, which is what keeps them in step.
 */
export async function recordRefund(
    db: Db,
    input: {
        /** The charge being reversed; one of these two finds it. */
        chargePaymentId?: string | null;
        provider: PaymentProvider;
        captureRef?: string | null;
        /** The provider's refund id. The idempotency key. */
        refundRef: string;
        amountCents: number;
        reason: string;
        actor: Actor;
        at?: Date;
    },
): Promise<RefundResult> {
    const at = input.at ?? new Date();

    return db.transaction(async (tx) => {
        const find = input.chargePaymentId
            ? eq(schema.payment.id, input.chargePaymentId)
            : and(
                  eq(schema.payment.provider, input.provider),
                  eq(schema.payment.captureRef, input.captureRef ?? ""),
              );

        /**
         * The customer's row first, because a refund can take credit back and
         * `payFromCredit` reads the balance under this same lock. Without it a
         * customer could spend a euro in one tab while the other was removing
         * it, and the ledger would go negative. The charge has to be read
         * unlocked to learn whose it is; the locked read below is the one that
         * decides anything.
         */
        const [owner] = await tx
            .select({ customerId: schema.payment.customerId })
            .from(schema.payment)
            .where(find);

        if (owner) {
            await tx
                .select({ id: schema.customer.id })
                .from(schema.customer)
                .where(eq(schema.customer.id, owner.customerId))
                .for("update");
        }

        const [charge] = await tx
            .select()
            .from(schema.payment)
            .where(find)
            .for("update");

        if (charge?.kind !== "charge") {
            return {
                ok: false as const,
                reason: "Zu dieser Zahlung gibt es keinen Vorgang.",
            };
        }

        const refundable = subtract(charge.amountCents, charge.refundedCents);

        if (input.amountCents <= 0 || input.amountCents > refundable) {
            return {
                ok: false as const,
                reason: "Es kann höchstens der noch nicht erstattete Betrag zurückgezahlt werden.",
            };
        }

        const refundPaymentId = createId("payment");

        const inserted = await tx
            .insert(schema.payment)
            .values({
                id: refundPaymentId,
                invoiceId: charge.invoiceId,
                customerId: charge.customerId,
                provider: charge.provider,
                status: "succeeded",
                kind: "refund",
                purpose: charge.purpose,
                parentPaymentId: charge.id,
                amountCents: input.amountCents,
                currency: charge.currency,
                providerRef: input.refundRef,
                captureRef: null,
                note: input.reason,
                settledAt: at,
                createdAt: at,
                updatedAt: at,
            })
            .onConflictDoNothing({ target: schema.payment.providerRef })
            .returning({ id: schema.payment.id });

        if (inserted.length === 0) {
            // Already recorded — the provider told us twice, or the admin
            // area and the webhook both got there.
            return { ok: true as const, changed: false, refundPaymentId: null };
        }

        const refundedCents = add(charge.refundedCents, input.amountCents);

        await tx
            .update(schema.payment)
            .set({
                refundedCents,
                status:
                    refundedCents >= charge.amountCents
                        ? "refunded"
                        : charge.status,
                updatedAt: at,
            })
            .where(eq(schema.payment.id, charge.id));

        /**
         * What this refund puts back into — or takes out of — the balance.
         * Both entries hang off the refund row, under different kinds, so the
         * unique index on `(payment_id, kind)` lets them coexist and makes a
         * repeat a no-op. A refund that touches neither writes neither.
         */
        const ledgerCents = await reverseChargeCredit(tx, {
            refundPaymentId,
            charge,
            amountCents: input.amountCents,
        });

        if (charge.invoiceId) {
            await resettleInvoice(tx, charge.invoiceId, at, refundPaymentId);
        }

        await audit(tx, {
            actor: input.actor,
            action: "payment.refund",
            entityType: "payment",
            entityId: charge.id,
            before: { refundedCents: charge.refundedCents },
            after: {
                refundedCents,
                refundPaymentId,
                amountCents: input.amountCents,
                refundRef: input.refundRef,
                reason: input.reason,
                creditLedgerCents: ledgerCents,
            },
        });

        return { ok: true as const, changed: true, refundPaymentId };
    });
}

/**
 * Sends money back through the gateway and then records it.
 *
 * In that order, and not the other way round: a row written first and a
 * refund that then fails is a customer who is told their money is on the way
 * when it is not. A refund that succeeds and whose row fails to write is the
 * other way round and is recoverable — the provider will report it as
 * `charge.refunded` and `recordRefund` will insert the same row under the
 * same reference.
 */
export async function refundPayment(
    db: Db,
    input: {
        paymentId: string;
        amountCents: number;
        reason: string;
        actor: Actor;
    },
): Promise<RefundResult> {
    const [charge] = await db
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.id, input.paymentId));

    if (charge?.kind !== "charge" || charge.status === "pending") {
        return {
            ok: false,
            reason: "Diese Zahlung kann nicht erstattet werden.",
        };
    }

    const refundable = subtract(charge.amountCents, charge.refundedCents);

    if (input.amountCents <= 0 || input.amountCents > refundable) {
        return {
            ok: false,
            reason: "Es kann höchstens der noch nicht erstattete Betrag zurückgezahlt werden.",
        };
    }

    const gateway = gatewayFor(charge.provider);

    if (!gateway?.capabilities.refunds) {
        /**
         * No API to ask — but for two different reasons, and they must not be
         * confused. A **transfer** moved real money, so the row is written and
         * the operator wires it back by hand. A **credit** payment moved no
         * money at all: it was the balance being spent, so reversing it is a
         * ledger entry and nothing else, which `recordRefund` now writes. The
         * caller is told which of the two happened, because "please transfer
         * 29,99 €" for a payment that was never money is how an operator pays
         * the same amount twice.
         */
        return recordRefund(db, {
            chargePaymentId: charge.id,
            provider: charge.provider,
            refundRef: `manual-refund:${createId("payment")}`,
            amountCents: input.amountCents,
            reason: input.reason,
            actor: input.actor,
        });
    }

    // How many refunds this charge has already seen, so a retry after a lost
    // response reaches the provider's *same* refund rather than making a
    // second one.
    const [existing] = await db
        .select({ value: count() })
        .from(schema.payment)
        .where(eq(schema.payment.parentPaymentId, charge.id));

    let refund: Awaited<ReturnType<typeof gateway.refund>>;

    try {
        refund = await gateway.refund(
            {
                ref: charge.providerRef,
                captureRef: charge.captureRef,
                // Part of the idempotency key — see RefundableTransaction.
                attempt: (existing?.value ?? 0) + 1,
            },
            input.amountCents,
        );
    } catch (error) {
        console.error("[payments] the refund was refused:", error);

        return {
            ok: false,
            reason:
                error instanceof Error
                    ? error.message
                    : "Die Erstattung wurde abgelehnt.",
        };
    }

    return recordRefund(db, {
        chargePaymentId: charge.id,
        provider: charge.provider,
        refundRef: refund.ref,
        amountCents: refund.amountCents,
        reason: input.reason,
        actor: input.actor,
    });
}

/**
 * A reversal we did not ask for: a chargeback, or a refund made in the
 * provider's own dashboard. Recorded like any other refund, under the
 * provider's reference, so the books follow the money even when the money
 * moved somewhere else.
 */
export async function recordReversal(
    db: Db,
    input: {
        provider: PaymentProvider;
        captureRef: string | null;
        refundRef: string;
        amountCents: number;
        event: string;
    },
): Promise<RefundResult> {
    if (!input.captureRef) {
        return {
            ok: false,
            reason: "Ohne Referenz lässt sich nichts zuordnen.",
        };
    }

    return recordRefund(db, {
        provider: input.provider,
        captureRef: input.captureRef,
        refundRef: input.refundRef,
        amountCents: input.amountCents,
        reason: `Zahlung zurückgegangen (${input.event})`,
        actor: { type: "system", label: input.provider },
    });
}
