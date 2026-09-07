import "server-only";
import Stripe from "stripe";
import { appUrl, stripeConfig, stripeEnabled } from "@/lib/payments/config";

/**
 * The Stripe client. No `apiVersion` is passed on purpose: the SDK then sends
 * the version it was built against, which is the one its own types describe.
 * The version is pinned by pinning the dependency, like everything else here.
 */
let client: Stripe | null = null;

export function stripe() {
    if (!stripeEnabled()) {
        throw new Error("STRIPE_SECRET_KEY is not set");
    }

    if (!client) {
        client = new Stripe(stripeConfig.secretKey, {
            maxNetworkRetries: 2,
            timeout: 20_000,
        });
    }

    return client;
}

/** The smallest amount Stripe accepts in EUR. */
const MINIMUM_CENTS = 50;

export type CheckoutInput = {
    invoiceId: string;
    invoiceNumber: string;
    amountCents: number;
    customerEmail: string;
    stripeCustomerId: string | null;
    /** Bumped per attempt so an abandoned session is not replayed forever. */
    attempt: number;
};

/**
 * A hosted Checkout page for one invoice. Nothing here may introduce tax:
 * automatic_tax, tax_rates, tax_id_collection and invoice_creation all stay
 * unset, because § 19 UStG means this seller never shows a tax line — and
 * invoice_creation would put a second, competing document in front of the
 * customer.
 */
export async function createInvoiceCheckout(input: CheckoutInput) {
    if (input.amountCents < MINIMUM_CENTS) {
        throw new Error("amount below the Stripe minimum");
    }

    const session = await stripe().checkout.sessions.create(
        {
            mode: "payment",
            line_items: [
                {
                    quantity: 1,
                    price_data: {
                        currency: "eur",
                        unit_amount: input.amountCents,
                        product_data: {
                            name: `Rechnung ${input.invoiceNumber}`,
                        },
                    },
                },
            ],
            client_reference_id: input.invoiceId,
            metadata: {
                invoice_id: input.invoiceId,
                invoice_number: input.invoiceNumber,
            },
            payment_intent_data: {
                description: `Rechnung ${input.invoiceNumber}`,
                metadata: {
                    invoice_id: input.invoiceId,
                    invoice_number: input.invoiceNumber,
                },
            },
            ...(input.stripeCustomerId
                ? { customer: input.stripeCustomerId }
                : { customer_email: input.customerEmail }),
            locale: "de",
            success_url: `${appUrl()}/account/invoices/${input.invoiceId}/paid?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl()}/account/invoices`,
        },
        {
            idempotencyKey: `invoice:${input.invoiceId}:attempt:${input.attempt}`,
        },
    );

    // A tripwire, not a formality: if Stripe Tax is ever switched on in the
    // dashboard, a § 19 seller would silently start showing VAT.
    if (
        session.total_details?.amount_tax !== 0 ||
        session.amount_total !== input.amountCents
    ) {
        throw new Error("Stripe returned a total this invoice does not have");
    }

    if (!session.url) {
        throw new Error("Stripe returned no checkout url");
    }

    return { id: session.id, url: session.url };
}

/** The Customer a stored payment method has to hang from. */
export async function ensureStripeCustomer(user: {
    id: string;
    name: string;
    email: string;
    stripeCustomerId: string | null;
}) {
    if (user.stripeCustomerId) {
        return user.stripeCustomerId;
    }

    const customer = await stripe().customers.create(
        {
            name: user.name,
            email: user.email,
            metadata: { user_id: user.id },
        },
        { idempotencyKey: `customer:${user.id}` },
    );

    return customer.id;
}

/**
 * The hosted page on which the customer authorises future charges. `currency`
 * is required in setup mode as soon as payment_method_types is left to the
 * dashboard, which is exactly what we want.
 */
export async function createSetupCheckout(input: {
    userId: string;
    stripeCustomerId: string;
    contractId: string | null;
}) {
    const session = await stripe().checkout.sessions.create({
        mode: "setup",
        currency: "eur",
        customer: input.stripeCustomerId,
        locale: "de",
        setup_intent_data: {
            metadata: {
                user_id: input.userId,
                contract_id: input.contractId ?? "",
            },
        },
        success_url: `${appUrl()}/account/payment-methods?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl()}/account/payment-methods`,
    });

    if (!session.url) {
        throw new Error("Stripe returned no setup url");
    }

    return { id: session.id, url: session.url };
}

/** Reads back what the customer stored, in a form worth showing them. */
export async function readStoredMethod(setupIntentId: string) {
    const intent = await stripe().setupIntents.retrieve(setupIntentId, {
        expand: ["payment_method"],
    });

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
        contractId: intent.metadata?.contract_id,
    };
}

/**
 * Collects an issued invoice from a stored method with nobody watching. A card
 * that now wants authentication comes back as `authentication_required`; there
 * is nothing to do about it here except report it, which is what the operator
 * asked for.
 */
export async function chargeStoredMethod(input: {
    invoiceId: string;
    invoiceNumber: string;
    amountCents: number;
    stripeCustomerId: string;
    token: string;
}) {
    const intent = await stripe().paymentIntents.create(
        {
            amount: input.amountCents,
            currency: "eur",
            customer: input.stripeCustomerId,
            payment_method: input.token,
            off_session: true,
            confirm: true,
            description: `Rechnung ${input.invoiceNumber}`,
            metadata: {
                invoice_id: input.invoiceId,
                invoice_number: input.invoiceNumber,
            },
        },
        { idempotencyKey: `collect:${input.invoiceId}` },
    );

    return intent;
}

/** Irreversible on Stripe's side — the row we keep is the only record left. */
export async function detachStoredMethod(token: string) {
    await stripe().paymentMethods.detach(token);
}

/** The provider's cut, once the balance transaction exists. */
export async function readFeeCents(paymentIntentId: string) {
    const intent = await stripe().paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge.balance_transaction"],
    });

    const charge = intent.latest_charge;

    if (!charge || typeof charge === "string") {
        return null;
    }

    const balance = charge.balance_transaction;

    return balance && typeof balance !== "string" ? balance.fee : null;
}
