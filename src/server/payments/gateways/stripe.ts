import "server-only";
import Stripe from "stripe";
import { db } from "@/db";
import {
    appUrl,
    gatewayConfig,
    type StripeCredentials,
} from "@/server/payments/settings";
import {
    type ChargeOutcome,
    type CheckoutHandoff,
    type CheckoutOptions,
    type GatewayCapabilities,
    type GatewayCustomer,
    GatewayError,
    type PayableInvoice,
    type PaymentGateway,
    type RefundableTransaction,
    type RefundOutcome,
    type SetupHandoff,
    type StoredMethod,
    type WebhookOutcome,
} from "./types";

/**
 * Stripe, behind the one interface.
 *
 * The bodies here predate the gateway abstraction and are kept as they were,
 * including the two decisions worth re-reading before changing them:
 *
 *  - **No `apiVersion` is passed.** The SDK then sends the version it was
 *    built against, which is the one its own types describe. The version is
 *    pinned by pinning the dependency, like everything else.
 *  - **Nothing may introduce tax.** `automatic_tax`, `tax_rates`,
 *    `tax_id_collection` and `invoice_creation` all stay unset: § 19 UStG
 *    means this seller shows no tax line, and `invoice_creation` would put a
 *    second, competing document in front of the customer. The total that
 *    comes back is compared against the one we sent, as a tripwire for Stripe
 *    Tax being switched on in the dashboard.
 */

/** One client per secret key, so a key changed in the admin area takes. */
const clients = new Map<string, Stripe>();

export async function stripeCredentials(): Promise<StripeCredentials> {
    const config = await gatewayConfig("stripe");

    if (!config.credentials.secretKey) {
        throw new GatewayError("stripe", "Stripe ist nicht eingerichtet.");
    }

    return config.credentials;
}

export async function stripeClient(): Promise<Stripe> {
    const { secretKey } = await stripeCredentials();

    let client = clients.get(secretKey);

    if (!client) {
        client = new Stripe(secretKey, {
            maxNetworkRetries: 2,
            timeout: 20_000,
        });
        clients.set(secretKey, client);
    }

    return client;
}

/** The smallest amount Stripe accepts in EUR. */
export const STRIPE_MINIMUM_CENTS = 50;

const capabilities: GatewayCapabilities = {
    hostedCheckout: true,
    storedMethods: true,
    offSession: true,
    refunds: true,
    webhooks: true,
    manual: false,
};

/** The Customer a stored payment method has to hang from. */
export async function ensureStripeCustomer(account: {
    id: string;
    name: string;
    email: string;
    stripeCustomerId?: string | null;
}): Promise<string> {
    if (account.stripeCustomerId) {
        return account.stripeCustomerId;
    }

    const stripe = await stripeClient();

    const created = await stripe.customers.create(
        {
            name: account.name,
            email: account.email,
            metadata: { customer_id: account.id },
        },
        { idempotencyKey: `customer:${account.id}` },
    );

    return created.id;
}

/**
 * Reads back what the customer stored, in a form worth showing them. Takes
 * the Checkout Session id, because that is the only thing the return URL
 * carries — the SetupIntent is resolved from it here rather than by every
 * caller.
 */
export async function readStoredMethod(sessionId: string) {
    const stripe = await stripeClient();

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["setup_intent.payment_method"],
    });

    const intent = session.setup_intent;

    if (!intent || typeof intent === "string") {
        return null;
    }

    const method = intent.payment_method;

    if (!method || typeof method === "string") {
        return null;
    }

    const label =
        method.type === "card" && method.card
            ? `${method.card.brand.toUpperCase()} •••• ${method.card.last4}`
            : method.type === "sepa_debit" && method.sepa_debit
              ? `SEPA-Lastschrift •••• ${method.sepa_debit.last4}`
              : method.type;

    return {
        token: method.id,
        label,
        contractId: intent.metadata?.contract_id || null,
        /** Written by savePaymentMethod, so the return can be checked. */
        customerId: intent.metadata?.customer_id || null,
    };
}

/** Irreversible on Stripe's side — the row we keep is the only record left. */
export async function detachStoredMethod(token: string) {
    const stripe = await stripeClient();

    await stripe.paymentMethods.detach(token);
}

/** The provider's cut, once the balance transaction exists. */
export async function readFeeCents(paymentIntentId: string) {
    const stripe = await stripeClient();

    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge.balance_transaction"],
    });

    const charge = intent.latest_charge;

    if (!charge || typeof charge === "string") {
        return null;
    }

    const balance = charge.balance_transaction;

    return balance && typeof balance !== "string" ? balance.fee : null;
}

export const stripeGateway: PaymentGateway = {
    id: "stripe",
    label: "Kreditkarte (Stripe)",
    capabilities,

    async isEnabled() {
        return (await gatewayConfig("stripe")).enabled;
    },

    async createCheckout(
        invoice: PayableInvoice,
        options: CheckoutOptions,
    ): Promise<CheckoutHandoff> {
        if (invoice.amountCents < STRIPE_MINIMUM_CENTS) {
            throw new GatewayError(
                "stripe",
                "Der Betrag liegt unter dem Mindestbetrag, den Stripe annimmt.",
                "below_minimum",
            );
        }

        const stripe = await stripeClient();

        const session = await stripe.checkout.sessions.create(
            {
                mode: "payment",
                // Pinned rather than left to the dashboard: § 7 (7) of the
                // terms and the Datenschutzerklärung both name card and
                // PayPal, and a method switched on in Stripe would silently
                // make them wrong. Adding SEPA means adding the mandate and
                // the Vorabankündigung to those texts first.
                payment_method_types: ["card"],
                line_items: [
                    {
                        quantity: 1,
                        price_data: {
                            currency: invoice.currency.toLowerCase(),
                            unit_amount: invoice.amountCents,
                            product_data: {
                                name:
                                    invoice.descriptor ??
                                    `Rechnung ${invoice.number}`,
                            },
                        },
                    },
                ],
                client_reference_id: invoice.id,
                metadata: {
                    invoice_id: invoice.id,
                    invoice_number: invoice.number,
                },
                payment_intent_data: {
                    description:
                        invoice.descriptor ?? `Rechnung ${invoice.number}`,
                    metadata: {
                        invoice_id: invoice.id,
                        invoice_number: invoice.number,
                    },
                },
                ...(invoice.stripeCustomerId
                    ? { customer: invoice.stripeCustomerId }
                    : { customer_email: invoice.customerEmail }),
                locale: "de",
                success_url: `${appUrl()}${options.returnPath ?? `/client/invoices/${invoice.id}/paid`}?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${appUrl()}${options.cancelPath ?? "/client/invoices"}`,
            },
            {
                idempotencyKey: `invoice:${invoice.id}:attempt:${options.attempt}`,
            },
        );

        // A tripwire, not a formality: if Stripe Tax is ever switched on in
        // the dashboard, a § 19 seller would silently start showing VAT.
        if (
            session.total_details?.amount_tax !== 0 ||
            session.amount_total !== invoice.amountCents
        ) {
            throw new GatewayError(
                "stripe",
                "Stripe nennt eine Summe, die diese Rechnung nicht hat.",
                "total_mismatch",
            );
        }

        if (!session.url) {
            throw new GatewayError("stripe", "Stripe lieferte keine Adresse.");
        }

        return { kind: "redirect", ref: session.id, url: session.url };
    },

    async savePaymentMethod(customer: GatewayCustomer): Promise<SetupHandoff> {
        const stripe = await stripeClient();
        const stripeCustomerId = await ensureStripeCustomer(customer);

        const session = await stripe.checkout.sessions.create({
            mode: "setup",
            // Required in setup mode once payment_method_types is given, and
            // what we want anyway: what may be stored is what the terms say
            // may be stored.
            currency: "eur",
            payment_method_types: ["card"],
            customer: stripeCustomerId,
            locale: "de",
            setup_intent_data: {
                metadata: { customer_id: customer.id },
            },
            success_url: `${appUrl()}/client/payment-methods?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl()}/client/payment-methods`,
        });

        if (!session.url) {
            throw new GatewayError("stripe", "Stripe lieferte keine Adresse.");
        }

        return { ref: session.id, url: session.url };
    },

    /**
     * Collects an issued invoice from a stored method with nobody watching.
     *
     * Created and confirmed in two steps on purpose: the create hands back
     * the id the attempt is recorded under *before* any money moves, so a
     * crash between the charge and the bookkeeping cannot leave a payment
     * nothing in here knows about.
     *
     * A card that now wants Strong Customer Authentication comes back as
     * `requires_action`. That is not a failure — the invoice is still
     * collectable, just not without the customer — so it gets its own
     * outcome and the caller mails them a link.
     */
    async chargeSaved(
        method: StoredMethod,
        invoice: PayableInvoice,
    ): Promise<ChargeOutcome> {
        const stripe = await stripeClient();
        const stripeCustomerId =
            method.stripeCustomerId ?? invoice.stripeCustomerId;

        if (!stripeCustomerId) {
            return {
                status: "failed",
                ref: null,
                code: "no_customer",
                message: "Zu diesem Zahlungsmittel fehlt das Stripe-Konto.",
            };
        }

        const intent = await stripe.paymentIntents.create(
            {
                amount: invoice.amountCents,
                currency: invoice.currency.toLowerCase(),
                customer: stripeCustomerId,
                payment_method: method.token,
                off_session: true,
                confirm: false,
                description: `Rechnung ${invoice.number}`,
                metadata: {
                    invoice_id: invoice.id,
                    invoice_number: invoice.number,
                },
            },
            { idempotencyKey: `collect:${invoice.id}` },
        );

        let confirmed: Stripe.PaymentIntent;

        try {
            confirmed = await stripe.paymentIntents.confirm(intent.id, {
                off_session: true,
            });
        } catch (error) {
            // Stripe throws for a declined off-session charge rather than
            // returning one, and the intent it carries is the authority on
            // why — including `requires_action`, which arrives as an error.
            const failure = error as Stripe.errors.StripeError;
            const carried = failure.payment_intent;

            if (carried?.status === "requires_action") {
                return {
                    status: "requires_action",
                    ref: carried.id,
                    url: null,
                };
            }

            return {
                status: "failed",
                ref: carried?.id ?? intent.id,
                code: failure.code ?? null,
                message: failure.message ?? null,
            };
        }

        if (confirmed.status === "succeeded") {
            return {
                status: "succeeded",
                ref: confirmed.id,
                captureRef: confirmed.id,
                // Stripe speaks in minor units already; nothing is parsed.
                amountCents: confirmed.amount_received,
                feeCents: null,
            };
        }

        if (confirmed.status === "requires_action") {
            return { status: "requires_action", ref: confirmed.id, url: null };
        }

        if (confirmed.status === "processing") {
            return {
                status: "processing",
                ref: confirmed.id,
                captureRef: confirmed.id,
            };
        }

        return {
            status: "failed",
            ref: confirmed.id,
            code: confirmed.last_payment_error?.code ?? confirmed.status,
            message: confirmed.last_payment_error?.message ?? null,
        };
    },

    async refund(
        transaction: RefundableTransaction,
        amountCents: number,
    ): Promise<RefundOutcome> {
        if (!transaction.captureRef) {
            throw new GatewayError(
                "stripe",
                "Zu dieser Zahlung ist keine Stripe-Referenz gespeichert.",
            );
        }

        const stripe = await stripeClient();

        const refund = await stripe.refunds.create(
            {
                payment_intent: transaction.captureRef,
                amount: amountCents,
            },
            {
                idempotencyKey: `refund:${transaction.captureRef}:${transaction.attempt}`,
            },
        );

        return {
            ref: refund.id,
            amountCents: refund.amount,
            status: refund.status === "succeeded" ? "succeeded" : "pending",
        };
    },

    async handleWebhook(request: Request): Promise<WebhookOutcome> {
        const { handleStripeWebhook } = await import("./stripe-webhook");

        return handleStripeWebhook(db, request);
    },
};
