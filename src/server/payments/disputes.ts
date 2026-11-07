import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { PaymentProvider } from "@/db/schema";
import { createId } from "@/lib/ulid";
import { audit } from "@/server/audit";
import { notifyDispute } from "./settle";

/**
 * Chargebacks.
 *
 * A table of their own rather than a status on the payment, because a dispute
 * has a life the payment does not: a deadline to answer by, evidence, and an
 * outcome that arrives weeks later — and one charge can be disputed, won, and
 * disputed again.
 *
 * Nothing here moves money. A dispute that is *lost* does, and the provider
 * says so separately: Stripe sends the reversal as its own event, which
 * `recordReversal` books like any other refund. Deciding here would book it
 * twice.
 */

type Db = typeof defaultDb;

const STATUS: Record<string, typeof schema.disputeStatus.enumValues[number]> = {
    warning_needs_response: "open",
    warning_under_review: "under_review",
    warning_closed: "withdrawn",
    needs_response: "open",
    under_review: "under_review",
    won: "won",
    lost: "lost",
};

export function disputeStatusFromStripe(value: string) {
    return STATUS[value] ?? "open";
}

/**
 * Writes or updates one dispute. Keyed on the provider's own id, so an event
 * delivered twice changes nothing the second time and a later update of the
 * same case lands on the same row.
 */
export async function recordDispute(
    db: Db,
    input: {
        provider: PaymentProvider;
        providerRef: string;
        /** The charge or intent the provider names. */
        captureRef: string | null;
        status: typeof schema.disputeStatus.enumValues[number];
        amountCents: number;
        currency?: string;
        reason?: string | null;
        respondBy?: Date | null;
    },
): Promise<{ changed: boolean; invoiceId: string | null }> {
    return db.transaction(async (tx) => {
        const [payment] = await tx
            .select()
            .from(schema.payment)
            .where(
                and(
                    eq(schema.payment.provider, input.provider),
                    eq(schema.payment.captureRef, input.captureRef ?? ""),
                ),
            );

        if (!payment) {
            // A dispute about a charge we have no record of. Nothing to hang
            // it on; the caller reports it as unmatched.
            return { changed: false, invoiceId: null };
        }

        const [existing] = await tx
            .select()
            .from(schema.paymentDispute)
            .where(eq(schema.paymentDispute.providerRef, input.providerRef))
            .for("update");

        const now = new Date();
        const closed =
            input.status === "won" ||
            input.status === "lost" ||
            input.status === "withdrawn";

        if (existing) {
            if (existing.status === input.status) {
                return { changed: false, invoiceId: payment.invoiceId };
            }

            await tx
                .update(schema.paymentDispute)
                .set({
                    status: input.status,
                    reason: input.reason ?? existing.reason,
                    respondBy: input.respondBy ?? existing.respondBy,
                    closedAt: closed ? (existing.closedAt ?? now) : null,
                    updatedAt: now,
                })
                .where(eq(schema.paymentDispute.id, existing.id));

            await audit(tx, {
                actor: { type: "system", label: input.provider },
                action: "dispute.update",
                entityType: "payment_dispute",
                entityId: existing.id,
                before: { status: existing.status },
                after: { status: input.status },
            });

            return { changed: true, invoiceId: payment.invoiceId };
        }

        const id = createId("dispute");

        await tx.insert(schema.paymentDispute).values({
            id,
            paymentId: payment.id,
            provider: input.provider,
            providerRef: input.providerRef,
            status: input.status,
            amountCents: input.amountCents,
            currency: input.currency ?? payment.currency,
            reason: input.reason ?? null,
            respondBy: input.respondBy ?? null,
            openedAt: now,
            closedAt: closed ? now : null,
        });

        await audit(tx, {
            actor: { type: "system", label: input.provider },
            action: "dispute.open",
            entityType: "payment_dispute",
            entityId: id,
            after: {
                paymentId: payment.id,
                status: input.status,
                amountCents: input.amountCents,
                reason: input.reason ?? null,
            },
        });

        return { changed: true, invoiceId: payment.invoiceId };
    });
}

/** The operator's list: open cases first, then by deadline. */
export async function listDisputes(db: Db, limit = 100) {
    return db
        .select({
            dispute: schema.paymentDispute,
            payment: schema.payment,
            invoiceNumber: schema.invoice.number,
            customerName: schema.customer.name,
        })
        .from(schema.paymentDispute)
        .innerJoin(
            schema.payment,
            eq(schema.paymentDispute.paymentId, schema.payment.id),
        )
        .leftJoin(
            schema.invoice,
            eq(schema.payment.invoiceId, schema.invoice.id),
        )
        .leftJoin(
            schema.customer,
            eq(schema.payment.customerId, schema.customer.id),
        )
        .orderBy(desc(schema.paymentDispute.id))
        .limit(limit);
}

/** Tells the operator, once a case has just been opened. */
export async function announceDispute(input: {
    invoiceNumber: string;
    amountCents: number;
    reason: string | null;
    respondBy: Date | null;
}) {
    await notifyDispute(input);
}
