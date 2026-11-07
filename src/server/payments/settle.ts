import "server-only";
import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import type { PaymentProvider } from "@/db/schema";
import { formatPrice } from "@/lib/format";
import { createId } from "@/lib/ulid";
import { notifyThresholds } from "@/server/billing/revenue-notify";
import { sendPaymentReceivedMail } from "@/server/documents/send";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/server/mail";
import { loadSettings } from "@/server/settings";
import type { ApplyOutcome } from "./apply";

/**
 * Recording an attempt before it is made, and everything that has to happen
 * *after* a payment has been applied — none of which may run inside the
 * transaction that applied it.
 *
 * The split matters. `applyPayment` holds a row lock on the invoice; sending
 * a mail from inside it would hold that lock for as long as the relay takes,
 * and a relay that hangs would be a payment nobody else can settle. So the
 * transaction returns what it did, and this file acts on it.
 */

/** How many attempts this invoice has already seen; the idempotency key. */
export async function nextAttempt(invoiceId: string) {
    const [row] = await db
        .select({ value: count() })
        .from(schema.payment)
        .where(eq(schema.payment.invoiceId, invoiceId));

    return (row?.value ?? 0) + 1;
}

/**
 * Writes down that we are about to ask for money. Always before the customer
 * is sent anywhere: a checkout session nobody recorded is money arriving at
 * the webhook with nothing to match it against — and matching it against
 * what the payload *says* is how an unverified request gets to name the
 * invoice it settles.
 */
export async function recordAttempt(input: {
    invoiceId: string | null;
    customerId: string;
    provider: PaymentProvider;
    providerRef: string;
    amountCents: number;
    purpose?: "invoice" | "topup";
    paymentMethodId?: string | null;
    note?: string | null;
}) {
    const id = createId("payment");

    await db.insert(schema.payment).values({
        id,
        invoiceId: input.invoiceId,
        customerId: input.customerId,
        provider: input.provider,
        providerRef: input.providerRef,
        amountCents: input.amountCents,
        purpose: input.purpose ?? "invoice",
        paymentMethodId: input.paymentMethodId ?? null,
        note: input.note ?? null,
    });

    return id;
}

/** The charge did not go through. Nothing about the invoice changes. */
export async function failPayment(input: {
    provider: PaymentProvider;
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
                // A payment that already settled is not failed by a late
                // `expired` event arriving behind the one that paid it.
                eq(schema.payment.status, "pending"),
            ),
        )
        .returning();

    return attempt ?? null;
}

/** A debit that has been submitted but is not money yet — SEPA takes days. */
export async function markProcessing(input: {
    provider: PaymentProvider;
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
 * Everything a settled payment sets off, once, outside the transaction.
 *
 * The plan calls this "emit `invoice.paid`". There is no event bus yet, so
 * this is the seam where one goes: every effect of money arriving is listed
 * here and nowhere else, and Phase 10 can replace the body without any
 * caller noticing.
 */
export async function emitInvoicePaid(
    outcome: ApplyOutcome,
    at = new Date(),
): Promise<void> {
    if (!outcome.changed) {
        return;
    }

    if (outcome.amountMismatch) {
        // The provider took a different figure from the one we asked for.
        // The money that moved is what was booked; somebody still has to look.
        await notifyAmountMismatch({
            invoiceNumber: outcome.invoiceNumber ?? outcome.invoiceId ?? "—",
            recordedCents: outcome.amountMismatch.recorded,
            reportedCents: outcome.amountMismatch.reported,
        });
    }

    // Revenue is counted from paid invoices, so this is one of the two
    // moments the § 19 figure can move. It never throws and sends at most one
    // mail per year, metric and level.
    if (outcome.invoiceStatus === "paid") {
        await notifyThresholds(db);
    }

    if (outcome.invoiceId && outcome.receiptTo) {
        const receipt = sendPaymentReceivedMail({
            invoiceId: outcome.invoiceId,
            to: outcome.receiptTo,
            amountCents: outcome.amountCents,
            paidAt: at,
            outstandingCents: outcome.outstandingCents,
        }).catch((error) => {
            console.error("[payments] receipt mail failed:", error);
        });

        // A webhook holds the customer's redirect while this runs and the
        // provider gives up after ten seconds, so the mail gets a few and
        // then finishes on its own time. The payment is settled either way;
        // a slow relay must not look like a failed webhook.
        await Promise.race([
            receipt,
            new Promise((resolve) => setTimeout(resolve, 4_000)),
        ]);
    }

    if (outcome.unexpected) {
        await notifyUnexpectedPayment({
            invoiceNumber: outcome.invoiceNumber ?? outcome.invoiceId ?? "—",
            status: outcome.invoiceStatus ?? "—",
            amountCents: outcome.amountCents,
        });
    }
}

/**
 * The routes a settled payment makes stale. Called by the webhooks and by the
 * server actions — never from inside a render, because revalidating during
 * one is not allowed.
 */
export function revalidateAfterPayment(invoiceId: string | null) {
    revalidatePath("/client/invoices");
    revalidatePath("/admin/invoices");
    revalidatePath("/admin/payments");
    revalidatePath("/client");

    if (invoiceId) {
        revalidatePath(`/admin/invoices/${invoiceId}`);
        revalidatePath(`/client/invoices/${invoiceId}`);
    }
}

async function operatorMail(subject: string, lines: string[], email: {
    preheader: string;
    heading: string;
    intro: string[];
    action?: { label: string; url: string };
    rows: { label: string; value: string }[];
}) {
    const { operator } = await loadSettings();
    const transport = createTransport();

    if (!transport) {
        console.error(`[payments] ${subject} — no mail transport:`, lines);
        return;
    }

    try {
        await transport.sendMail({
            from: await mailFrom(),
            to: operator.email,
            subject,
            text: lines.join("\n"),
            html: await renderEmail({
                preheader: email.preheader,
                heading: email.heading,
                intro: email.intro,
                ...(email.action ? { action: email.action } : {}),
                rowsTitle: "Eckdaten",
                rows: email.rows,
            }),
        });
    } catch (error) {
        logMailError(subject, error);
    }
}

/**
 * Money we cannot match to anything we started. Rare, and exactly the case
 * that must not pass quietly: it means either a payment nobody recorded, or a
 * reference from a different system pointing at this account.
 */
export async function notifyUnmatchedPayment(input: {
    provider: PaymentProvider;
    providerRef: string;
    event: string;
}) {
    console.error("[payments] a payment matched no attempt:", input);

    const { site } = await loadSettings();

    await operatorMail(
        `Zahlung ohne Zuordnung — ${input.provider}`,
        [
            `${input.provider} meldet ${input.event} für ${input.providerRef}, aber dazu gibt es hier keinen Zahlungsvorgang.`,
            "",
            "Es wurde nichts verbucht. Bitte im Konto des Anbieters nachsehen, worum es geht.",
            `${site.url}/admin/payments`,
        ],
        {
            preheader: `${input.provider}: Zahlung ohne Zuordnung.`,
            heading: "Zahlung ohne Zuordnung",
            intro: [
                `${input.provider} meldet ${input.event} für ${input.providerRef}, aber dazu gibt es hier keinen Zahlungsvorgang. Es wurde nichts verbucht.`,
            ],
            action: {
                label: "Zahlungen öffnen",
                url: `${site.url}/admin/payments`,
            },
            rows: [
                { label: "Anbieter", value: input.provider },
                { label: "Ereignis", value: input.event },
                { label: "Referenz", value: input.providerRef },
            ],
        },
    );
}

/**
 * Money for an invoice that was not waiting for it. Nothing is undone
 * automatically — a refund is a decision, and § 8 leaves it to the operator.
 */
async function notifyUnexpectedPayment(input: {
    invoiceNumber: string;
    status: string;
    amountCents: number;
}) {
    const { site } = await loadSettings();

    await operatorMail(
        `Unerwarteter Zahlungseingang — ${input.invoiceNumber}`,
        [
            `Für ${input.invoiceNumber} ist eine Zahlung über ${formatPrice(input.amountCents)} eingegangen, obwohl die Rechnung den Status „${input.status}“ hat.`,
            "",
            "Die Zahlung ist erfasst, der Rechnungsstatus wurde nicht verändert. Bitte prüfen, ob der Betrag zu erstatten ist.",
            `${site.url}/admin/invoices`,
        ],
        {
            preheader: `Zahlung zu ${input.invoiceNumber}, die nicht erwartet war.`,
            heading: "Unerwarteter Zahlungseingang",
            intro: [
                `Für ${input.invoiceNumber} ist eine Zahlung über ${formatPrice(input.amountCents)} eingegangen, obwohl die Rechnung den Status „${input.status}“ hat. Die Zahlung ist erfasst, der Rechnungsstatus wurde nicht verändert.`,
            ],
            action: {
                label: "Rechnungen öffnen",
                url: `${site.url}/admin/invoices`,
            },
            rows: [
                { label: "Rechnung", value: input.invoiceNumber },
                { label: "Status", value: input.status },
                { label: "Betrag", value: formatPrice(input.amountCents) },
            ],
        },
    );
}

/**
 * The provider moved a different amount from the one we asked for. The money
 * that actually moved is what was booked — anything else would be a second
 * arithmetic — but a difference is never normal.
 */
async function notifyAmountMismatch(input: {
    invoiceNumber: string;
    recordedCents: number;
    reportedCents: number;
}) {
    const { site } = await loadSettings();

    await operatorMail(
        `Abweichender Zahlbetrag — ${input.invoiceNumber}`,
        [
            `Für ${input.invoiceNumber} war ein Vorgang über ${formatPrice(input.recordedCents)} erfasst; der Anbieter meldet ${formatPrice(input.reportedCents)}.`,
            "",
            "Verbucht wurde der gemeldete Betrag — das ist das Geld, das tatsächlich geflossen ist.",
            `${site.url}/admin/payments`,
        ],
        {
            preheader: `${input.invoiceNumber}: der Anbieter meldet einen anderen Betrag.`,
            heading: "Abweichender Zahlbetrag",
            intro: [
                `Für ${input.invoiceNumber} war ein Vorgang über ${formatPrice(input.recordedCents)} erfasst; der Anbieter meldet ${formatPrice(input.reportedCents)}. Verbucht wurde der gemeldete Betrag.`,
            ],
            action: {
                label: "Zahlungen öffnen",
                url: `${site.url}/admin/payments`,
            },
            rows: [
                { label: "Rechnung", value: input.invoiceNumber },
                { label: "Erfasst", value: formatPrice(input.recordedCents) },
                { label: "Gemeldet", value: formatPrice(input.reportedCents) },
            ],
        },
    );
}

/** A payment that went back out, or a chargeback. */
export async function notifyReversal(input: {
    invoiceId: string | null;
    amountCents: number;
    event: string;
}) {
    const { site } = await loadSettings();
    const target = input.invoiceId
        ? `${site.url}/admin/invoices/${input.invoiceId}`
        : `${site.url}/admin/payments`;

    await operatorMail(
        `Zahlung zurückgegangen — ${input.event}`,
        [
            `Eine Zahlung über ${formatPrice(input.amountCents)} ist zurückgegangen (${input.event}).`,
            "",
            "Der Vorgang ist erfasst und die Rechnung steht wieder offen. Ob sie zu korrigieren ist, entscheidest du.",
            target,
        ],
        {
            preheader: `Zahlung über ${formatPrice(input.amountCents)} zurückgegangen.`,
            heading: "Zahlung zurückgegangen",
            intro: [
                `Eine Zahlung über ${formatPrice(input.amountCents)} ist zurückgegangen (${input.event}). Der Vorgang ist erfasst und die Rechnung steht wieder offen; ob sie zu korrigieren ist, entscheidest du.`,
            ],
            action: { label: "Vorgang öffnen", url: target },
            rows: [
                { label: "Betrag", value: formatPrice(input.amountCents) },
                { label: "Ereignis", value: input.event },
            ],
        },
    );
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
    const { site } = await loadSettings();

    await operatorMail(
        `Einzug fehlgeschlagen — ${input.invoiceNumber}`,
        [
            `Der Einzug für ${input.invoiceNumber} über ${formatPrice(input.amountCents)} ist fehlgeschlagen.`,
            `Konto: ${input.customerEmail}`,
            `Grund: ${input.reason}`,
            "",
            "Die Rechnung bleibt offen. Es wird nichts automatisch erneut versucht.",
            `${site.url}/admin/invoices`,
        ],
        {
            preheader: `Einzug für ${input.invoiceNumber} fehlgeschlagen.`,
            heading: "Einzug fehlgeschlagen",
            intro: [
                `Der Einzug für ${input.invoiceNumber} ist fehlgeschlagen. Die Rechnung bleibt offen; es wird nichts automatisch erneut versucht.`,
            ],
            action: {
                label: "Rechnungen öffnen",
                url: `${site.url}/admin/invoices`,
            },
            rows: [
                { label: "Rechnung", value: input.invoiceNumber },
                { label: "Betrag", value: formatPrice(input.amountCents) },
                { label: "Konto", value: input.customerEmail },
                { label: "Grund", value: input.reason },
            ],
        },
    );
}

/** A chargeback was opened. The deadline is the part that matters. */
export async function notifyDispute(input: {
    invoiceNumber: string;
    amountCents: number;
    reason: string | null;
    respondBy: Date | null;
}) {
    const { site } = await loadSettings();

    await operatorMail(
        `Zahlung angefochten — ${input.invoiceNumber}`,
        [
            `Zu ${input.invoiceNumber} wurde eine Zahlung über ${formatPrice(input.amountCents)} angefochten.`,
            input.reason ? `Grund des Anbieters: ${input.reason}` : "",
            input.respondBy
                ? `Stellungnahme bis: ${input.respondBy.toISOString().slice(0, 10)}`
                : "",
            "",
            `${site.url}/admin/payments/disputes`,
        ].filter((line) => line !== ""),
        {
            preheader: `${input.invoiceNumber}: eine Zahlung wurde angefochten.`,
            heading: "Zahlung angefochten",
            intro: [
                `Zu ${input.invoiceNumber} wurde eine Zahlung über ${formatPrice(input.amountCents)} angefochten. Die Frist des Anbieters läuft, sobald der Fall eröffnet ist.`,
            ],
            action: {
                label: "Fälle öffnen",
                url: `${site.url}/admin/payments/disputes`,
            },
            rows: [
                { label: "Rechnung", value: input.invoiceNumber },
                { label: "Betrag", value: formatPrice(input.amountCents) },
                { label: "Grund", value: input.reason ?? "—" },
                {
                    label: "Frist",
                    value: input.respondBy
                        ? input.respondBy.toISOString().slice(0, 10)
                        : "—",
                },
            ],
        },
    );
}
