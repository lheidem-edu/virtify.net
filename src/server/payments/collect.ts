import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { isOpenInvoice } from "@/db/schema";
import { subtract } from "@/lib/money";
import type { Actor } from "@/server/audit";
import { loadInvoice } from "@/server/billing/invoices/repository";
import { applyPayment } from "./apply";
import { type GatewayId, gateway } from "./gateways";
import { captureApprovedOrder } from "./gateways/paypal";
import { stripeClient } from "./gateways/stripe";
import type { CheckoutHandoff, PayableInvoice } from "./gateways/types";
import { sendPaymentActionRequiredMail } from "./mail";
import { defaultMethod } from "./methods";
import {
    emitInvoicePaid,
    failPayment,
    markProcessing,
    nextAttempt,
    notifyCollectionFailed,
    recordAttempt,
} from "./settle";

/**
 * Taking the money, from both directions: the customer who pressed a button,
 * and the subscription that collects itself when an invoice is issued.
 *
 * Every path here writes the attempt down **before** the customer is sent
 * anywhere or a charge is confirmed. A checkout session nobody recorded is
 * money arriving at a webhook with nothing to match it against — and matching
 * it against what the payload claims is how an unverified request gets to
 * name the invoice it settles.
 */

export type StartResult =
    | { ok: true; handoff: CheckoutHandoff }
    | { ok: false; reason: string };

/** What a gateway is told about the invoice, and nothing more. */
async function payable(
    invoiceId: string,
    customerId: string,
): Promise<
    { ok: true; invoice: PayableInvoice } | { ok: false; reason: string }
> {
    // The loader constrains the query to this account, so a foreign invoice
    // comes back as null rather than as a refusal that confirms it exists.
    const loaded = await loadInvoice(invoiceId, customerId, false);

    if (!loaded) {
        return { ok: false, reason: "Diese Rechnung gibt es nicht." };
    }

    const { invoice, buyer, totals } = loaded;

    if (!invoice.number || !isOpenInvoice(invoice.status)) {
        return {
            ok: false,
            reason: "Diese Rechnung kann nicht bezahlt werden.",
        };
    }

    // What is actually still owed — the document's own total, less the
    // corrections and less what has already arrived. Nothing is recomputed
    // from the lines; `calculateTotals()` said what this invoice is worth and
    // `applyPayment` said how much of it has been received.
    const outstanding = subtract(
        Math.max(subtract(totals.grossCents, invoice.creditedCents), 0),
        invoice.paidCents,
    );

    if (outstanding <= 0) {
        return {
            ok: false,
            reason: "Diese Rechnung weist keinen offenen Betrag aus.",
        };
    }

    const [customer] = await db
        .select({
            id: schema.customer.id,
            name: schema.customer.name,
            stripeCustomerId: schema.customer.stripeCustomerId,
        })
        .from(schema.customer)
        .where(eq(schema.customer.id, customerId));

    return {
        ok: true,
        invoice: {
            id: invoice.id,
            number: invoice.number,
            amountCents: outstanding,
            currency: invoice.currency,
            customerId,
            customerEmail: buyer.email,
            customerName: customer?.name ?? buyer.name,
            stripeCustomerId: customer?.stripeCustomerId ?? null,
        },
    };
}

/**
 * Hands one invoice to a gateway.
 *
 * An abandoned checkout stays payable at the provider until it expires, so
 * the ones this invoice has left open are closed before a new one is started:
 * two live sessions for one invoice are two ways to pay it, and the customer
 * with an old tab open would pay twice through no fault of their own.
 */
export async function startPayment(input: {
    invoiceId: string;
    customerId: string;
    gatewayId: GatewayId;
}): Promise<StartResult> {
    const target = gateway(input.gatewayId);

    if (!target || !(await target.isEnabled())) {
        return {
            ok: false,
            reason: "Diese Zahlungsart steht gerade nicht zur Verfügung.",
        };
    }

    const resolved = await payable(input.invoiceId, input.customerId);

    if (!resolved.ok) {
        return resolved;
    }

    try {
        if (target.capabilities.hostedCheckout) {
            await closeOpenAttempts(resolved.invoice.id);
        }

        const handoff = await target.createCheckout(resolved.invoice, {
            attempt: await nextAttempt(resolved.invoice.id),
        });

        // Bank transfer records no attempt: nothing has been promised and
        // nothing is in flight. The payment row is written when the money is
        // booked, which is the moment it exists.
        if (handoff.kind === "redirect") {
            await recordAttempt({
                invoiceId: resolved.invoice.id,
                customerId: input.customerId,
                provider: input.gatewayId,
                providerRef: handoff.ref,
                amountCents: resolved.invoice.amountCents,
            });
        }

        return { ok: true, handoff };
    } catch (error) {
        console.error("[payments] starting the payment failed:", error);

        return {
            ok: false,
            reason: "Die Zahlung konnte nicht gestartet werden. Bitte versuche es erneut.",
        };
    }
}

/**
 * Closes everything an invoice has left in flight before a new attempt is
 * started.
 *
 * Two live ways to pay one invoice are two ways to pay it twice: the customer
 * with an old tab open, or a collection the gateway has not finished, would
 * both go through and the second one would be money the customer never meant
 * to send. So the provider is told to close them, and the row is marked
 * superseded either way — the row is what decides whether we offer it again.
 *
 * A gateway that refuses because the thing has already been paid is not a
 * problem: the webhook settles it, `applyPayment` is idempotent, and the new
 * attempt finds nothing left to collect.
 */
export async function closeOpenAttempts(invoiceId: string) {
    const open = await db
        .select({
            id: schema.payment.id,
            provider: schema.payment.provider,
            providerRef: schema.payment.providerRef,
        })
        .from(schema.payment)
        .where(
            and(
                eq(schema.payment.invoiceId, invoiceId),
                eq(schema.payment.status, "pending"),
            ),
        );

    for (const attempt of open) {
        try {
            // Only Stripe can be told to close something; a PayPal order the
            // customer never approved simply expires, and capturing one needs
            // an approval it will never get.
            if (attempt.provider === "stripe") {
                const stripe = await stripeClient();

                if (attempt.providerRef.startsWith("cs_")) {
                    await stripe.checkout.sessions.expire(attempt.providerRef);
                } else if (attempt.providerRef.startsWith("pi_")) {
                    // An off-session collection that is still in flight. The
                    // row alone would stop *us* offering it again, but not
                    // Stripe from completing it — and then the customer pays
                    // twice for one invoice.
                    await stripe.paymentIntents.cancel(attempt.providerRef);
                }
            }
        } catch (error) {
            // Already expired, already paid, or gone — either way the row
            // below is what stops us offering it again.
            console.error(
                "[payments] expiring the old checkout failed:",
                error,
            );
        }

        await failPayment({
            provider: attempt.provider,
            providerRef: attempt.providerRef,
            code: "superseded",
            message: "Durch einen neuen Zahlungsvorgang ersetzt.",
        });
    }
}

/**
 * Settles a Stripe checkout the customer has just come back from. The webhook
 * is the authority and will do this too — this only spares the customer a
 * page that still says "offen" about money they just handed over.
 *
 * The session id arrives in a URL the customer could edit, so it is trusted
 * for nothing: the session's own metadata has to name the invoice the route
 * is about, and `applyPayment` then only recognises an attempt we recorded
 * ourselves.
 */
export async function settleCheckoutReturn(
    sessionId: string,
    invoiceId: string,
): Promise<boolean> {
    const stripe = await stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.invoice_id !== invoiceId) {
        return false;
    }

    if (session.payment_status === "unpaid") {
        return false;
    }

    const intentId =
        typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

    const outcome = await applyPayment(db, {
        ref: session.id,
        gateway: "stripe",
        captureRef: intentId,
        amountCents: session.amount_total ?? undefined,
        actor: { type: "system", label: "stripe-return" },
    });

    await emitInvoicePaid(outcome);

    return outcome.known;
}

/**
 * Captures an approved PayPal order the customer has just come back from.
 * The webhook does this too, and PayPal answers whichever is second
 * ORDER_ALREADY_CAPTURED — which is a success, not a fault.
 */
export async function captureAndSettle(orderId: string): Promise<boolean> {
    const capture = await captureApprovedOrder(orderId);

    if (capture.captureStatus !== "COMPLETED") {
        await failPayment({
            provider: "paypal",
            providerRef: orderId,
            code: capture.captureStatus ?? capture.status,
        });

        return false;
    }

    const outcome = await applyPayment(db, {
        ref: orderId,
        gateway: "paypal",
        captureRef: capture.captureId,
        amountCents: capture.amountCents ?? undefined,
        feeCents: capture.feeCents,
        actor: { type: "system", label: "paypal-return" },
    });

    await emitInvoicePaid(outcome);

    return outcome.known;
}

export type CollectionResult =
    | { attempted: false }
    | { attempted: true; status: "succeeded" | "processing" }
    | { attempted: true; status: "requires_action"; mailed: boolean }
    | { attempted: true; status: "failed"; reason: string };

/**
 * Collects an issued invoice from the payment method the customer stored.
 *
 * Runs after the invoice is committed and never rolls it back: a failed
 * collection leaves an ordinary open invoice, which is exactly what it is.
 * Nothing is retried automatically — the operator decides, as they asked.
 *
 * The one outcome worth reading twice is `requires_action`: the card now
 * wants Strong Customer Authentication and there is nobody standing in front
 * of it to give it. That is not a failure, so the customer gets a link to a
 * page where they can authenticate, and the invoice stays open until they do.
 */
export async function collectIssuedInvoice(
    invoiceId: string,
    actor: Actor = { type: "system", label: "collection" },
): Promise<CollectionResult> {
    const [row] = await db
        .select({
            invoiceId: schema.invoice.id,
            number: schema.invoice.number,
            status: schema.invoice.status,
            currency: schema.invoice.currency,
            grossCents: schema.invoice.grossCents,
            creditedCents: schema.invoice.creditedCents,
            paidCents: schema.invoice.paidCents,
            buyerEmail: schema.invoice.buyerEmail,
            customerId: schema.invoice.customerId,
            customerName: schema.customer.name,
            stripeCustomerId: schema.customer.stripeCustomerId,
        })
        .from(schema.invoice)
        .innerJoin(
            schema.customer,
            eq(schema.invoice.customerId, schema.customer.id),
        )
        .where(eq(schema.invoice.id, invoiceId));

    if (!row?.number || !isOpenInvoice(row.status)) {
        return { attempted: false };
    }

    const amountCents = subtract(
        Math.max(subtract(row.grossCents ?? 0, row.creditedCents), 0),
        row.paidCents,
    );

    if (amountCents <= 0) {
        return { attempted: false };
    }

    const method = await methodFor(invoiceId, row.customerId);

    if (!method) {
        return { attempted: false };
    }

    const target = gateway(method.provider as GatewayId);

    if (!target?.capabilities.offSession) {
        return { attempted: false };
    }

    const email = row.buyerEmail ?? (await ownerEmail(row.customerId)) ?? "";

    const invoice: PayableInvoice = {
        id: row.invoiceId,
        number: row.number,
        amountCents,
        currency: row.currency,
        customerId: row.customerId,
        customerEmail: email,
        customerName: row.customerName,
        stripeCustomerId: row.stripeCustomerId,
    };

    let outcome: Awaited<ReturnType<typeof target.chargeSaved>>;

    try {
        outcome = await target.chargeSaved(
            {
                id: method.id,
                provider: method.provider as GatewayId,
                token: method.token,
                label: method.label,
                stripeCustomerId: row.stripeCustomerId,
            },
            invoice,
        );
    } catch (error) {
        const reason = error instanceof Error ? error.message : "unbekannt";

        console.error("[payments] collecting the invoice failed:", error);

        await notifyCollectionFailed({
            invoiceNumber: row.number,
            customerEmail: email,
            amountCents,
            reason,
        });

        return { attempted: true, status: "failed", reason };
    }

    // Written down before anything is reported, and keyed on the reference
    // the gateway handed back — which is what the webhook will carry too.
    if (outcome.status !== "failed" && outcome.ref) {
        await recordAttempt({
            invoiceId: row.invoiceId,
            customerId: row.customerId,
            provider: method.provider,
            providerRef: outcome.ref,
            amountCents,
            paymentMethodId: method.id,
        }).catch((error) => {
            // A reference we have already recorded: the gateway's own
            // idempotency returned the same object. Nothing to do.
            console.error(
                "[payments] the attempt was already recorded:",
                error,
            );
        });
    }

    if (outcome.status === "succeeded") {
        const applied = await applyPayment(db, {
            ref: outcome.ref,
            gateway: method.provider,
            captureRef: outcome.captureRef,
            amountCents: outcome.amountCents,
            feeCents: outcome.feeCents,
            paymentMethodId: method.id,
            /**
             * Named here, unlike on the webhook path, and that difference is
             * deliberate: this collection was started by *us*, for an invoice
             * we picked, so there is nothing to trust. It is what makes the
             * case where the charge went through but the attempt row did not
             * recoverable — `applyPayment` writes the row rather than
             * reporting money it cannot place.
             */
            invoiceId: row.invoiceId,
            customerId: row.customerId,
            actor,
        });

        await emitInvoicePaid(applied);

        return { attempted: true, status: "succeeded" };
    }

    if (outcome.status === "processing") {
        await markProcessing({
            provider: method.provider,
            providerRef: outcome.ref,
        });

        return { attempted: true, status: "processing" };
    }

    if (outcome.status === "requires_action") {
        const mailed = await askForAuthentication({
            invoice,
            customerId: row.customerId,
            gatewayId: method.provider as GatewayId,
        });

        await failPayment({
            provider: method.provider,
            providerRef: outcome.ref,
            code: "authentication_required",
            message:
                "Die Bank verlangt eine Bestätigung durch den Kunden (SCA).",
        });

        return { attempted: true, status: "requires_action", mailed };
    }

    await failPayment({
        provider: method.provider,
        providerRef: outcome.ref ?? `failed:${invoiceId}:${Date.now()}`,
        code: outcome.code,
        message: outcome.message,
    }).catch(() => undefined);

    const reason = outcome.code ?? outcome.message ?? "unbekannt";

    await notifyCollectionFailed({
        invoiceNumber: row.number,
        customerEmail: email,
        amountCents,
        reason,
    });

    return { attempted: true, status: "failed", reason };
}

/**
 * The card an off-session collection reaches for: the one the subscription
 * behind this invoice names, then the legacy contract's, then the account's
 * default. A method the customer has withdrawn is never used.
 */
async function methodFor(invoiceId: string, customerId: string) {
    const [bySubscription] = await db
        .select({
            id: schema.paymentMethod.id,
            provider: schema.paymentMethod.provider,
            token: schema.paymentMethod.token,
            label: schema.paymentMethod.label,
        })
        .from(schema.order)
        .innerJoin(
            schema.subscription,
            eq(schema.subscription.orderId, schema.order.id),
        )
        .innerJoin(
            schema.paymentMethod,
            eq(schema.subscription.paymentMethodId, schema.paymentMethod.id),
        )
        .where(
            and(
                eq(schema.order.invoiceId, invoiceId),
                eq(schema.subscription.autoCharge, true),
                isNull(schema.paymentMethod.revokedAt),
            ),
        )
        .limit(1);

    if (bySubscription) {
        return bySubscription;
    }

    const [byContract] = await db
        .select({
            id: schema.paymentMethod.id,
            provider: schema.paymentMethod.provider,
            token: schema.paymentMethod.token,
            label: schema.paymentMethod.label,
        })
        .from(schema.invoice)
        .innerJoin(
            schema.contract,
            eq(schema.invoice.contractId, schema.contract.id),
        )
        .innerJoin(
            schema.paymentMethod,
            eq(schema.contract.paymentMethodId, schema.paymentMethod.id),
        )
        .where(
            and(
                eq(schema.invoice.id, invoiceId),
                isNull(schema.paymentMethod.revokedAt),
            ),
        )
        .limit(1);

    if (byContract) {
        return byContract;
    }

    return defaultMethod(db, customerId);
}

/**
 * SCA: open a hosted checkout the customer can authenticate in, and mail them
 * the link. The attempt is recorded first, as everywhere else.
 */
async function askForAuthentication(input: {
    invoice: PayableInvoice;
    customerId: string;
    gatewayId: GatewayId;
}): Promise<boolean> {
    try {
        const target = gateway(input.gatewayId);

        if (!target?.capabilities.hostedCheckout) {
            return false;
        }

        const handoff = await target.createCheckout(input.invoice, {
            attempt: await nextAttempt(input.invoice.id),
        });

        if (handoff.kind !== "redirect") {
            return false;
        }

        await recordAttempt({
            invoiceId: input.invoice.id,
            customerId: input.customerId,
            provider: input.gatewayId,
            providerRef: handoff.ref,
            amountCents: input.invoice.amountCents,
            note: "Bestätigung durch den Kunden (SCA) erforderlich",
        });

        await sendPaymentActionRequiredMail({
            to: input.invoice.customerEmail,
            invoiceNumber: input.invoice.number,
            amountCents: input.invoice.amountCents,
            url: handoff.url,
        });

        return true;
    } catch (error) {
        console.error(
            "[payments] could not offer the customer an authentication link:",
            error,
        );

        return false;
    }
}

/** The account's owner, for a notice when the invoice froze no address. */
async function ownerEmail(customerId: string) {
    const [row] = await db
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
