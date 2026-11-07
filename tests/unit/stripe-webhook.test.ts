import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which Stripe event actually books a reversal.
 *
 * The handler used to read the refunds off the charge:
 * `for (const refund of charge.refunds?.data ?? [])`. From API version
 * 2022-11-15 the Charge object no longer auto-expands them and an event
 * payload cannot be expanded, so that list is absent and the loop ran zero
 * times — a refund made in the Stripe dashboard was verified, claimed,
 * answered 200 and booked nowhere. Stripe's own description of the event says
 * it now: "Listen to `refund.created` for information about the refund."
 *
 * These tests feed the payloads Stripe really sends — a `charge.refunded`
 * with no `refunds` key at all — and assert what reaches `recordReversal`.
 */

const reversals: {
    captureRef: string | null;
    refundRef: string;
    amountCents: number;
    event: string;
}[] = [];

const alerts: { kind: string; ref: string }[] = [];

let listed: unknown[] = [];
let verified: unknown = null;

vi.mock("@/server/payments/settings", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/server/payments/settings")>();

    return {
        ...actual,
        gatewayConfig: vi.fn(async () => ({
            id: "stripe",
            label: "stripe",
            enabled: true,
            mode: "sandbox" as const,
            source: "environment" as const,
            paypalRecurringMode: "vault" as const,
            credentials: {
                secretKey: "sk_test_double",
                webhookSecret: "whsec_double",
            },
        })),
    };
});

vi.mock("@/server/payments/webhook-log", () => ({
    claimEvent: vi.fn(async () => true),
    markEventHandled: vi.fn(async () => {}),
}));

vi.mock("@/server/payments/refunds", () => ({
    recordReversal: vi.fn(async (_db: unknown, input: never) => {
        reversals.push(input);

        return { ok: true as const, changed: true, refundPaymentId: "p" };
    }),
}));

vi.mock("@/server/payments/settle", () => ({
    emitInvoicePaid: vi.fn(async () => {}),
    failPayment: vi.fn(async () => {}),
    markProcessing: vi.fn(async () => {}),
    notifyDispute: vi.fn(async () => {}),
    notifyReversal: vi.fn(async () => {}),
    notifyUnbookedReversal: vi.fn(async (input: { providerRef: string }) => {
        alerts.push({ kind: "unbooked", ref: input.providerRef });
    }),
    notifyUnmatchedPayment: vi.fn(async (input: { providerRef: string }) => {
        alerts.push({ kind: "unmatched", ref: input.providerRef });
    }),
}));

vi.mock("@/server/payments/apply", () => ({
    applyPayment: vi.fn(async () => ({
        known: true,
        changed: true,
        invoiceId: "invoice_01",
    })),
}));

vi.mock("@/server/payments/disputes", () => ({
    recordDispute: vi.fn(async () => ({ changed: true, invoiceId: null })),
    disputeStatusFromStripe: () => "open",
}));

vi.mock("@/server/payments/methods", () => ({
    claimSetup: vi.fn(async () => null),
    storeMethod: vi.fn(async () => {}),
}));

/**
 * The handler reaches for the SDK through `stripeClient()`, so that is the
 * seam. The signature check itself is Stripe's own code and is not what
 * these tests are about: the verified event is the input, and what the
 * branches do with it is the claim.
 */
vi.mock("@/server/payments/gateways/stripe", () => ({
    readFeeCents: vi.fn(async () => null),
    readStoredMethod: vi.fn(async () => null),
    stripeClient: vi.fn(async () => ({
        webhooks: { constructEvent: () => verified },
        refunds: { list: async () => ({ data: listed }) },
    })),
}));

/** Enough of a `db` for the two reads the handler makes on these paths. */
const db = {
    select: () => ({
        from: () => ({
            where: async () => [
                { invoiceId: "invoice_01", customerId: "customer_01" },
            ],
        }),
    }),
} as never;

async function deliver(event: unknown) {
    const { handleStripeWebhook } = await import(
        "@/server/payments/gateways/stripe-webhook"
    );

    verified = event;

    return handleStripeWebhook(
        db,
        new Request("https://virtify.net/api/webhooks/stripe", {
            method: "POST",
            headers: { "stripe-signature": "t=1,v1=x" },
            body: "{}",
        }),
    );
}

beforeEach(() => {
    reversals.length = 0;
    alerts.length = 0;
    listed = [];
    verified = null;
});

describe("a refund Stripe reports", () => {
    it("books it from refund.created, which carries the refund itself", async () => {
        await deliver({
            id: "evt_1",
            type: "refund.created",
            data: {
                object: {
                    id: "re_1",
                    amount: 2999,
                    status: "succeeded",
                    payment_intent: "pi_1",
                },
            },
        });

        expect(reversals).toEqual([
            {
                provider: "stripe",
                captureRef: "pi_1",
                refundRef: "re_1",
                amountCents: 2999,
                event: "refund.created",
            },
        ]);
    });

    it("ignores a refund that has not landed yet", async () => {
        await deliver({
            id: "evt_2",
            type: "refund.created",
            data: {
                object: {
                    id: "re_2",
                    amount: 2999,
                    status: "pending",
                    payment_intent: "pi_2",
                },
            },
        });

        // A pending refund is not money that moved. `refund.updated` brings
        // it back when it is.
        expect(reversals).toEqual([]);
    });

    it("still books one when only charge.refunded is subscribed", async () => {
        // Note what the payload does NOT have: a `refunds` list. This is the
        // shape Stripe actually sends, and the old handler read nothing from
        // it. The refunds are asked for instead.
        listed = [
            { id: "re_3", amount: 1000, status: "succeeded" },
            { id: "re_4", amount: 500, status: "succeeded" },
        ];

        await deliver({
            id: "evt_3",
            type: "charge.refunded",
            data: {
                object: {
                    id: "ch_3",
                    amount_refunded: 1500,
                    payment_intent: "pi_3",
                },
            },
        });

        expect(
            reversals.map((row) => [row.refundRef, row.amountCents]),
        ).toEqual([
            ["re_3", 1000],
            ["re_4", 500],
        ]);
    });

    it("tells somebody when a reversal cannot be booked", async () => {
        const { recordReversal } = await import("@/server/payments/refunds");

        vi.mocked(recordReversal).mockResolvedValueOnce({
            ok: false,
            reason: "Es kann höchstens der noch nicht erstattete Betrag zurückgezahlt werden.",
        });

        await deliver({
            id: "evt_4",
            type: "refund.created",
            data: {
                object: {
                    id: "re_5",
                    amount: 9999,
                    status: "succeeded",
                    payment_intent: "pi_4",
                },
            },
        });

        // The money has left and our books still say it is here. Returning
        // quietly marked the event handled, so Stripe never retried either.
        expect(alerts).toEqual([{ kind: "unbooked", ref: "re_5" }]);
    });
});

describe("a dispute Stripe settles", () => {
    it("takes the money back out when the funds are withdrawn", async () => {
        await deliver({
            id: "evt_5",
            type: "charge.dispute.funds_withdrawn",
            data: {
                object: {
                    id: "dp_1",
                    amount: 11_900,
                    payment_intent: "pi_5",
                    status: "lost",
                },
            },
        });

        // Without this the invoice stayed `paid` after a lost chargeback and
        // the § 19 revenue monitor went on counting it.
        expect(reversals).toEqual([
            {
                provider: "stripe",
                captureRef: "pi_5",
                refundRef: "dp_1:withdrawn",
                amountCents: 11_900,
                event: "charge.dispute.funds_withdrawn",
            },
        ]);
    });

    it("puts it back when the dispute is won", async () => {
        const { applyPayment } = await import("@/server/payments/apply");

        await deliver({
            id: "evt_6",
            type: "charge.dispute.funds_reinstated",
            data: {
                object: {
                    id: "dp_2",
                    amount: 11_900,
                    payment_intent: "pi_6",
                    status: "won",
                },
            },
        });

        expect(vi.mocked(applyPayment)).toHaveBeenCalledWith(
            db,
            expect.objectContaining({
                ref: "dp_2:reinstated",
                gateway: "stripe",
                invoiceId: "invoice_01",
                customerId: "customer_01",
                amountCents: 11_900,
            }),
        );
    });
});

describe("a PaymentIntent that is already booked under its session", () => {
    it("does not raise the unmatched-money alarm", async () => {
        const { applyPayment } = await import("@/server/payments/apply");

        vi.mocked(applyPayment).mockResolvedValueOnce({
            known: false,
        } as never);

        await deliver({
            id: "evt_7",
            type: "payment_intent.succeeded",
            data: {
                object: { id: "pi_7", amount_received: 2999 },
            },
        });

        // A hosted Checkout payment arrives twice: once as the session, which
        // is the reference the attempt was recorded under, and once as the
        // intent, which is not. Alerting on the second fires "Zahlung ohne
        // Zuordnung" on every ordinary card payment, which is how the one
        // alarm that means unbookable money becomes the one nobody reads.
        expect(alerts).toEqual([]);
    });
});
