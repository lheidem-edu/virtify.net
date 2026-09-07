import "server-only";
import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import { formatPrice } from "@/lib/format";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/lib/mail";
import { operator, site } from "@/lib/site";

/**
 * Everything that decides whether an invoice is paid lives here, once. Both
 * providers retry their webhooks, both can be beaten to the punch by the
 * customer's own return to the site, and an off-session charge can answer
 * twice — so every entry point has to be safe to run again.
 */

export type Provider = "stripe" | "paypal";

/** How many attempts this invoice has already seen; the idempotency key. */
export async function nextAttempt(invoiceId: string) {
    const [row] = await db
        .select({ value: count() })
        .from(schema.payment)
        .where(eq(schema.payment.invoiceId, invoiceId));

    return (row?.value ?? 0) + 1;
}

export async function recordAttempt(input: {
    invoiceId: string;
    userId: string;
    provider: Provider;
    providerRef: string;
    amountCents: number;
    paymentMethodId?: string | null;
}) {
    const id = createId("payment");

    await db.insert(schema.payment).values({
        id,
        invoiceId: input.invoiceId,
        userId: input.userId,
        provider: input.provider,
        providerRef: input.providerRef,
        amountCents: input.amountCents,
        paymentMethodId: input.paymentMethodId ?? null,
    });

    return id;
}

/**
 * The money arrived. Marks the attempt settled and the invoice paid, both
 * conditionally: a second delivery of the same event finds the row already
 * succeeded and changes nothing, and an invoice that is no longer "issued"
 * (corrected in the meantime, say) is left alone rather than overwritten.
 */
export async function settlePayment(input: {
    provider: Provider;
    providerRef: string;
    captureRef: string | null;
    feeCents?: number | null;
    at?: Date;
}) {
    const settledAt = input.at ?? new Date();

    const outcome = await db.transaction(async (tx) => {
        const [attempt] = await tx
            .select()
            .from(schema.payment)
            .where(
                and(
                    eq(schema.payment.provider, input.provider),
                    eq(schema.payment.providerRef, input.providerRef),
                ),
            )
            .for("update");

        if (!attempt) {
            return { known: false, changed: false, invoiceId: null };
        }

        if (attempt.status === "succeeded") {
            return {
                known: true,
                changed: false,
                invoiceId: attempt.invoiceId,
            };
        }

        await tx
            .update(schema.payment)
            .set({
                status: "succeeded",
                captureRef: input.captureRef,
                feeCents: input.feeCents ?? attempt.feeCents,
                failureCode: null,
                failureMessage: null,
                settledAt,
                updatedAt: settledAt,
            })
            .where(eq(schema.payment.id, attempt.id));

        const [invoice] = await tx
            .select()
            .from(schema.invoice)
            .where(eq(schema.invoice.id, attempt.invoiceId))
            .for("update");

        // Only an invoice that is still open becomes paid. A corrected or
        // already paid one keeps the state it has; the payment row records
        // that money came in either way, which is what the books need.
        if (invoice?.status === "issued") {
            await tx
                .update(schema.invoice)
                .set({
                    status: "paid",
                    paidAt: settledAt,
                    updatedAt: settledAt,
                })
                .where(eq(schema.invoice.id, invoice.id));
        }

        return { known: true, changed: true, invoiceId: attempt.invoiceId };
    });

    if (outcome.changed) {
        revalidatePath("/account/invoices");
        revalidatePath("/account/admin/invoices");
        revalidatePath(`/account/admin/invoices/${outcome.invoiceId}`);
        revalidatePath("/account");
    }

    return outcome;
}

/** The charge did not go through. Nothing about the invoice changes. */
export async function failPayment(input: {
    provider: Provider;
    providerRef: string;
    code?: string | null;
    message?: string | null;
}) {
    const now = new Date();

    const [attempt] = await db
        .update(schema.payment)
        .set({
            status: "failed",
            failureCode: input.code ?? null,
            failureMessage: input.message ?? null,
            updatedAt: now,
        })
        .where(
            and(
                eq(schema.payment.provider, input.provider),
                eq(schema.payment.providerRef, input.providerRef),
            ),
        )
        .returning();

    return attempt ?? null;
}

/** A debit that has been submitted but is not money yet — SEPA takes days. */
export async function markProcessing(input: {
    provider: Provider;
    providerRef: string;
}) {
    await db
        .update(schema.payment)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
            and(
                eq(schema.payment.provider, input.provider),
                eq(schema.payment.providerRef, input.providerRef),
                eq(schema.payment.status, "pending"),
            ),
        );
}

/**
 * Providers deliver the same event more than once, on purpose. The primary key
 * is the guard: the first delivery inserts, every later one finds the row and
 * the handler stops.
 */
export async function firstDelivery(event: {
    id: string;
    provider: Provider;
    type: string;
}) {
    const inserted = await db
        .insert(schema.webhookEvent)
        .values(event)
        .onConflictDoNothing()
        .returning({ id: schema.webhookEvent.id });

    return inserted.length > 0;
}

/**
 * The operator is the only human in the loop, and a collection that fails
 * off-session has no customer standing in front of it. § 8 of the terms lets
 * them decide what happens next, so this only tells them.
 */
export async function notifyCollectionFailed(input: {
    invoiceNumber: string;
    customerEmail: string;
    amountCents: number;
    reason: string;
}) {
    const transport = createTransport();

    if (!transport) {
        console.error(
            "[payments] collection failed and no mail transport is configured:",
            input,
        );
        return;
    }

    try {
        await transport.sendMail({
            from: mailFrom,
            to: operator.email,
            subject: `Einzug fehlgeschlagen — ${input.invoiceNumber}`,
            text: [
                `Der Einzug für ${input.invoiceNumber} über ${formatPrice(input.amountCents)} ist fehlgeschlagen.`,
                `Konto: ${input.customerEmail}`,
                `Grund: ${input.reason}`,
                "",
                "Die Rechnung bleibt offen. Es wird nichts automatisch erneut versucht.",
                `${site.url}/account/admin/invoices`,
            ].join("\n"),
            html: renderEmail({
                preheader: `Einzug für ${input.invoiceNumber} fehlgeschlagen.`,
                heading: "Einzug fehlgeschlagen",
                intro: [
                    `Der Einzug für ${input.invoiceNumber} ist fehlgeschlagen. Die Rechnung bleibt offen; es wird nichts automatisch erneut versucht.`,
                ],
                action: {
                    label: "Rechnungen öffnen",
                    url: `${site.url}/account/admin/invoices`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Rechnung", value: input.invoiceNumber },
                    { label: "Betrag", value: formatPrice(input.amountCents) },
                    { label: "Konto", value: input.customerEmail },
                    { label: "Grund", value: input.reason },
                ],
            }),
        });
    } catch (error) {
        logMailError("collection failure notice", error);
    }
}
