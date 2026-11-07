import "server-only";
import { z } from "zod";
import { zId } from "@/lib/ulid";
import type { TransactionRow } from "./repository";

/**
 * The wire shape of a transaction, and the parsers for what comes in.
 *
 * Next to the service rather than in the route, so the admin area, the API
 * and the tests all agree on what a transaction looks like from outside —
 * snake_case on the wire, cents as integers, dates as ISO-8601 in UTC.
 */

export const transactionQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    customer_id: z.string().optional(),
    invoice_id: z.string().optional(),
    provider: z
        .enum(["stripe", "paypal", "banktransfer", "credit"])
        .optional(),
    status: z
        .enum(["pending", "processing", "succeeded", "failed", "refunded"])
        .optional(),
    kind: z.enum(["charge", "refund"]).optional(),
});

/**
 * Booking a payment through the API.
 *
 * `idempotency_key` is required and is not a courtesy: it becomes the
 * payment's `provider_ref`, which is unique, so a retried request after a
 * lost response books once instead of twice. A caller who will not supply one
 * is told so rather than quietly risking a double booking.
 */
export const recordPaymentSchema = z.object({
    amount_cents: z.int().min(1).max(99_999_999),
    gateway: z
        .enum(["banktransfer", "stripe", "paypal"])
        .default("banktransfer"),
    idempotency_key: z.string().trim().min(8).max(200),
    reference: z.string().trim().max(200).nullish(),
    note: z.string().trim().max(500).nullish(),
    /** When the money actually arrived. Defaults to now. */
    received_at: z.iso.datetime().nullish(),
});

export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>;

export function serializeTransaction(row: TransactionRow) {
    return {
        id: row.id,
        invoice_id: row.invoiceId,
        customer_id: row.customerId,
        gateway: row.provider,
        status: row.status,
        kind: row.kind,
        purpose: row.purpose,
        parent_payment_id: row.parentPaymentId,
        amount_cents: row.amountCents,
        refunded_cents: row.refundedCents,
        currency: row.currency,
        gateway_ref: row.providerRef,
        capture_ref: row.captureRef,
        fee_cents: row.feeCents,
        failure_code: row.failureCode,
        failure_message: row.failureMessage,
        note: row.note,
        settled_at: row.settledAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
    };
}

export { zId };
