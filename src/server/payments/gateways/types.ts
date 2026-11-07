import "server-only";
import type { GatewayId, GatewayMode } from "@/server/payments/settings";

/**
 * The one shape every way of taking money is reduced to.
 *
 * The sentence the whole interface follows from, and the reason it is this
 * small: **our billing engine is the source of truth for subscriptions; a
 * gateway only collects money.** Nothing here returns a price, a period, a
 * plan or a status that belongs to an invoice. A gateway is handed a figure
 * that was computed by `calculateTotals()` and frozen onto a document, and it
 * comes back with "the money moved" or "it did not" and a reference we can
 * recognise later.
 *
 * `banktransfer` implements the same interface with no API behind it at all,
 * which is the point: a payment booked by hand and a payment captured by
 * Stripe reach `applyPayment` through one path, so an invoice cannot be
 * settled twice by two different mechanisms that do not know about each
 * other.
 */

export type { GatewayId, GatewayMode };

export type GatewayCapabilities = {
    /** Can send the customer to a page of its own to pay one invoice. */
    hostedCheckout: boolean;
    /** Can store an authorisation for later use. */
    storedMethods: boolean;
    /** Can charge a stored authorisation with nobody watching. */
    offSession: boolean;
    /** Can send money back out through its API. */
    refunds: boolean;
    /** Tells us about events by itself. */
    webhooks: boolean;
    /** Needs a human to confirm the money arrived. */
    manual: boolean;
};

/**
 * What a gateway is told about the invoice it is collecting. Deliberately a
 * flat record of already-decided facts rather than the invoice row: a gateway
 * that could see the lines is a gateway that could add them up differently.
 */
export type PayableInvoice = {
    id: string;
    /** The gapless number. A draft has none and is never payable. */
    number: string;
    /** What is still owed, in whole minor units. Never recomputed here. */
    amountCents: number;
    currency: string;
    customerId: string;
    customerEmail: string;
    customerName: string;
    /** The provider's own customer id, where one has been made. */
    stripeCustomerId?: string | null;
};

export type GatewayCustomer = {
    id: string;
    name: string;
    email: string;
    stripeCustomerId?: string | null;
};

export type StoredMethod = {
    id: string;
    provider: GatewayId;
    /** The provider's token. Never a card number and never an IBAN. */
    token: string;
    label: string;
    stripeCustomerId?: string | null;
};

export type CheckoutOptions = {
    /**
     * Bumped per attempt, so an abandoned session is not replayed forever
     * and a retry after a lost response reaches the same object at the
     * provider instead of creating a second one.
     */
    attempt: number;
    /** Where to send the browser when it comes back. */
    returnPath?: string;
    cancelPath?: string;
};

/**
 * How the customer is taken to the payment.
 *
 * `redirect` is a hosted page. `instructions` is a bank transfer: there is
 * nowhere to send anybody, only something to show them — which is why this is
 * a union rather than a URL that `banktransfer` would have to invent.
 */
export type CheckoutHandoff =
    | {
          kind: "redirect";
          /** The reference the attempt is recorded under. */
          ref: string;
          url: string;
      }
    | {
          kind: "instructions";
          ref: string;
          instructions: BankTransferInstructions;
      };

export type BankTransferInstructions = {
    holder: string;
    iban: string;
    bic: string;
    bankName: string;
    amountCents: number;
    currency: string;
    /** Verwendungszweck — the invoice number, which is what reconciles it. */
    remittance: string;
    /** EPC QR payload, ready for a banking app. SVG, rendered server-side. */
    giroCodeSvg: string | null;
};

export type SetupHandoff = {
    /** The provider's id for the setup, stored before the redirect. */
    ref: string;
    url: string;
};

/**
 * The result of asking a gateway for money without a customer present.
 *
 * `requires_action` is the one that matters: a card that now wants Strong
 * Customer Authentication cannot be charged off-session, and there is nobody
 * to authenticate. It is not a failure — the invoice is still collectable —
 * so it is its own outcome, and the caller mails the customer a link.
 */
export type ChargeOutcome =
    | {
          status: "succeeded";
          ref: string;
          captureRef: string | null;
          /** The provider's own minor-unit integer, never a parsed float. */
          amountCents: number;
          feeCents: number | null;
      }
    | {
          status: "processing";
          ref: string;
          captureRef: string | null;
      }
    | {
          status: "requires_action";
          ref: string;
          /** Where the customer can finish it, when the gateway offers one. */
          url: string | null;
      }
    | {
          status: "failed";
          ref: string | null;
          code: string | null;
          message: string | null;
      };

export type RefundableTransaction = {
    /** What the charge was recorded under. */
    ref: string;
    /** What actually moved the money, and what a refund points at. */
    captureRef: string | null;
    /**
     * Which refund of this charge this is, counting from 1. Part of the
     * idempotency key, so a retry after a lost response reaches the
     * provider's same refund instead of making a second one.
     */
    attempt: number;
};

export type RefundOutcome = {
    /** The provider's id for the refund — the idempotency key for applying it. */
    ref: string;
    amountCents: number;
    /** `pending` for a method that takes days to reverse. */
    status: "succeeded" | "pending";
};

/** What a verified webhook turned out to mean. The route only transports it. */
export type WebhookOutcome = {
    /** The provider's event id; the dedupe key. */
    eventId: string;
    type: string;
    /** Set when the handler changed an invoice, so the route can revalidate. */
    invoiceId?: string | null;
    /** `false` makes the route answer 400 instead of 200. */
    verified: boolean;
    /** The event had already been handled; nothing ran this time. */
    duplicate?: boolean;
};

export interface PaymentGateway {
    readonly id: GatewayId;
    readonly label: string;
    readonly capabilities: GatewayCapabilities;

    /** Whether it is switched on and has what it needs. */
    isEnabled(): Promise<boolean>;

    /**
     * Start paying one invoice. Returns somewhere to go or something to show;
     * recording the attempt is the caller's job, because the caller is the one
     * inside the transaction.
     */
    createCheckout(
        invoice: PayableInvoice,
        options: CheckoutOptions,
    ): Promise<CheckoutHandoff>;

    /** Start storing an authorisation for later. */
    savePaymentMethod(customer: GatewayCustomer): Promise<SetupHandoff>;

    /** Collect an issued invoice from a stored authorisation, off-session. */
    chargeSaved(
        method: StoredMethod,
        invoice: PayableInvoice,
    ): Promise<ChargeOutcome>;

    /** Send money back out. `amountCents` may be less than the charge. */
    refund(
        transaction: RefundableTransaction,
        amountCents: number,
    ): Promise<RefundOutcome>;

    /** Verify, interpret and act on one delivery. */
    handleWebhook(request: Request): Promise<WebhookOutcome>;
}

/** Thrown where a gateway cannot do what was asked and the caller must say so. */
export class GatewayError extends Error {
    constructor(
        readonly gateway: GatewayId,
        message: string,
        readonly code: string | null = null,
    ) {
        super(message);
        this.name = "GatewayError";
    }
}

/** A gateway that does not implement an optional capability. */
export function unsupported(gateway: GatewayId, what: string): never {
    throw new GatewayError(
        gateway,
        `${gateway} kann ${what} nicht.`,
        "unsupported",
    );
}
