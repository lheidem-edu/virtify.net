import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { isOpenInvoice } from "@/db/schema";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import {
    invalid,
    json,
    malformed,
    notFound,
    problem,
} from "@/server/api/respond";
import {
    recordPaymentSchema,
    serializeTransaction,
} from "@/server/payments/api";
import { applyPayment } from "@/server/payments/apply";
import { loadTransaction } from "@/server/payments/repository";
import { emitInvoicePaid } from "@/server/payments/settle";

export const dynamic = "force-dynamic";

/**
 * Books a payment against one invoice. Staff only.
 *
 * This is the API's half of "Zahlungseingang erfassen" in the admin area, and
 * it goes through the same `applyPayment` — the only path by which an invoice
 * is ever settled. A partial amount leaves the invoice open as `partial`; an
 * amount beyond what is owed becomes the customer's credit rather than
 * inflating the invoice.
 *
 * `idempotency_key` becomes the payment's unique gateway reference, so a
 * client that retries after a lost response books once.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await authenticate(request, "payments.write");

    if (!auth.ok) {
        return auth.response;
    }

    // A customer key may read its transactions and may not create any: money
    // arriving is something the operator observes, not something the payer
    // declares. `payments.write` is not in CUSTOMER_SCOPES, so the guard
    // above already refuses one — this is the second lock, for the day that
    // list changes. 404 rather than 403, because by this point the answer
    // would be about the invoice: see the note in `server/api/auth.ts`.
    if (scopedCustomerId(auth.context)) {
        return notFound();
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed("Der Körper ist kein gültiges JSON.");
    }

    const parsed = recordPaymentSchema.safeParse(body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const { id } = await params;

    const [invoice] = await db
        .select({
            id: schema.invoice.id,
            customerId: schema.invoice.customerId,
            status: schema.invoice.status,
            grossCents: schema.invoice.grossCents,
            creditedCents: schema.invoice.creditedCents,
            paidCents: schema.invoice.paidCents,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.id, id));

    if (!invoice) {
        return notFound();
    }

    if (invoice.status === "draft") {
        return problem(
            422,
            "Entwurf",
            "Ein Entwurf ist nicht zahlbar. Stelle die Rechnung zuerst aus.",
        );
    }

    if (!isOpenInvoice(invoice.status)) {
        return problem(
            409,
            "Nicht offen",
            "Diese Rechnung ist nicht offen; ein Eingang darauf wäre eine Überzahlung und will von Hand entschieden werden.",
        );
    }

    const receivedAt = parsed.data.received_at
        ? new Date(parsed.data.received_at)
        : new Date();

    const outcome = await applyPayment(db, {
        ref: `${parsed.data.gateway}:${parsed.data.idempotency_key}`,
        gateway: parsed.data.gateway,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        amountCents: parsed.data.amount_cents,
        note:
            [parsed.data.reference, parsed.data.note]
                .filter(Boolean)
                .join(" · ") || null,
        at: receivedAt,
        actor: {
            type: "api",
            id: auth.context.key.id,
            label: auth.context.key.prefix,
        },
    });

    if (!outcome.changed) {
        if (outcome.known && outcome.paymentId) {
            // The same idempotency key, booked before. The caller gets the
            // transaction they already created rather than a second one.
            const existing = await loadTransaction(db, outcome.paymentId, null);

            if (existing) {
                return json(serializeTransaction(existing), 200);
            }
        }

        return problem(
            422,
            "Nicht verbucht",
            "Der Zahlungseingang konnte dieser Rechnung nicht zugeordnet werden.",
        );
    }

    await emitInvoicePaid(outcome, receivedAt);

    const created = outcome.paymentId
        ? await loadTransaction(db, outcome.paymentId, null)
        : null;

    if (!created) {
        return notFound();
    }

    return json(
        {
            ...serializeTransaction(created),
            invoice: {
                status: outcome.invoiceStatus,
                paid_cents: outcome.paidCents,
                outstanding_cents: outcome.outstandingCents,
                credited_to_balance_cents: outcome.creditedToBalanceCents,
            },
        },
        201,
    );
}
