import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two gateways, with the network mocked.
 *
 * What is being proved here is the translation, not the providers: that a
 * card asking for Strong Customer Authentication comes back as its own
 * outcome rather than a failure, and that money crossing the boundary from
 * PayPal's decimal strings lands on the exact cent.
 */

/** A Stripe double. Each test installs the behaviour it is about. */
const stripeState = {
    create: vi.fn(),
    confirm: vi.fn(),
    refundCreate: vi.fn(),
    sessionCreate: vi.fn(),
};

vi.mock("stripe", () => {
    class StripeDouble {
        paymentIntents = {
            create: (...args: unknown[]) => stripeState.create(...args),
            confirm: (...args: unknown[]) => stripeState.confirm(...args),
        };
        refunds = {
            create: (...args: unknown[]) => stripeState.refundCreate(...args),
        };
        checkout = {
            sessions: {
                create: (...args: unknown[]) =>
                    stripeState.sessionCreate(...args),
            },
        };
        customers = { create: vi.fn() };
        webhooks = { constructEvent: vi.fn() };
    }

    return { default: StripeDouble };
});

/**
 * The configuration, without a database and without the environment. The
 * real module reads an encrypted row or `.env.local`; neither belongs in a
 * unit test, and both would make the result depend on the machine.
 */
vi.mock("@/server/payments/settings", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/server/payments/settings")
        >();

    return {
        ...actual,
        gatewayConfig: vi.fn(async (id: string) => ({
            id,
            label: id,
            enabled: true,
            mode: "sandbox" as const,
            source: "environment" as const,
            paypalRecurringMode: "vault" as const,
            credentials:
                id === "stripe"
                    ? { secretKey: "sk_test_double", webhookSecret: "whsec" }
                    : {
                          clientId: "client",
                          clientSecret: "secret",
                          webhookId: "WH-1",
                      },
        })),
        loadGatewayConfigs: vi.fn(),
        appUrl: () => "https://example.test",
    };
});

const INVOICE = {
    id: "invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD",
    number: "RE-2026-0012",
    amountCents: 2999,
    currency: "EUR",
    customerId: "customer_01K9ZC4X7QG0VN3M8T6B2PFHRD",
    customerEmail: "kunde@example.test",
    customerName: "Kunde",
    stripeCustomerId: "cus_double",
};

const METHOD = {
    id: "paymentmethod_01K9ZC4X7QG0VN3M8T6B2PFHRD",
    provider: "stripe" as const,
    token: "pm_double",
    label: "VISA •••• 4242",
    stripeCustomerId: "cus_double",
};

describe("the Stripe gateway", () => {
    beforeEach(() => {
        for (const fn of Object.values(stripeState)) {
            fn.mockReset();
        }
    });

    it("reports a card that now wants authentication as requires_action", async () => {
        const { stripeGateway } = await import(
            "@/server/payments/gateways/stripe"
        );

        stripeState.create.mockResolvedValue({
            id: "pi_sca",
            status: "requires_confirmation",
        });

        // Stripe throws for a declined off-session charge rather than
        // returning one, and the intent it carries is the authority on why.
        stripeState.confirm.mockRejectedValue(
            Object.assign(new Error("authentication required"), {
                code: "authentication_required",
                payment_intent: { id: "pi_sca", status: "requires_action" },
            }),
        );

        const outcome = await stripeGateway.chargeSaved(METHOD, INVOICE);

        // Not a failure: the invoice is still collectable, just not without
        // the customer. The caller mails them a link.
        expect(outcome).toEqual({
            status: "requires_action",
            ref: "pi_sca",
            url: null,
        });
    });

    it("creates the intent before confirming it", async () => {
        const { stripeGateway } = await import(
            "@/server/payments/gateways/stripe"
        );

        stripeState.create.mockResolvedValue({
            id: "pi_ok",
            status: "requires_confirmation",
        });
        stripeState.confirm.mockResolvedValue({
            id: "pi_ok",
            status: "succeeded",
            amount_received: 2999,
        });

        const outcome = await stripeGateway.chargeSaved(METHOD, INVOICE);

        // The create hands back the id the attempt is recorded under *before*
        // any money moves, so a crash in between cannot leave a payment
        // nothing in here knows about.
        expect(stripeState.create).toHaveBeenCalledWith(
            expect.objectContaining({
                amount: 2999,
                confirm: false,
                off_session: true,
            }),
            { idempotencyKey: `collect:${INVOICE.id}` },
        );

        expect(outcome).toEqual({
            status: "succeeded",
            ref: "pi_ok",
            captureRef: "pi_ok",
            // Stripe's own minor-unit integer, not a parsed float.
            amountCents: 2999,
            feeCents: null,
        });
    });

    it("reports a declined card as failed, with the provider's reason", async () => {
        const { stripeGateway } = await import(
            "@/server/payments/gateways/stripe"
        );

        stripeState.create.mockResolvedValue({
            id: "pi_declined",
            status: "requires_confirmation",
        });
        stripeState.confirm.mockRejectedValue(
            Object.assign(new Error("Your card was declined."), {
                code: "card_declined",
                payment_intent: {
                    id: "pi_declined",
                    status: "requires_payment_method",
                },
            }),
        );

        const outcome = await stripeGateway.chargeSaved(METHOD, INVOICE);

        expect(outcome).toMatchObject({
            status: "failed",
            ref: "pi_declined",
            code: "card_declined",
        });
    });

    it("refuses a total Stripe does not agree with", async () => {
        const { stripeGateway } = await import(
            "@/server/payments/gateways/stripe"
        );

        // The tripwire for Stripe Tax being switched on in the dashboard: a
        // § 19 seller would otherwise silently start showing VAT.
        stripeState.sessionCreate.mockResolvedValue({
            id: "cs_taxed",
            url: "https://checkout.stripe.test/cs_taxed",
            amount_total: 3568,
            total_details: { amount_tax: 569 },
        });

        await expect(
            stripeGateway.createCheckout(INVOICE, { attempt: 1 }),
        ).rejects.toThrow(/Summe/);
    });

    it("refunds through the capture reference, with an idempotency key", async () => {
        const { stripeGateway } = await import(
            "@/server/payments/gateways/stripe"
        );

        stripeState.refundCreate.mockResolvedValue({
            id: "re_1",
            amount: 1000,
            status: "succeeded",
        });

        const outcome = await stripeGateway.refund(
            { ref: "cs_1", captureRef: "pi_1", attempt: 2 },
            1000,
        );

        expect(stripeState.refundCreate).toHaveBeenCalledWith(
            { payment_intent: "pi_1", amount: 1000 },
            { idempotencyKey: "refund:pi_1:2" },
        );
        expect(outcome).toEqual({
            ref: "re_1",
            amountCents: 1000,
            status: "succeeded",
        });
    });
});

describe("the PayPal gateway", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);

        // Every call starts with the OAuth token.
        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes("/v1/oauth2/token")) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        access_token: "token",
                        expires_in: 3600,
                    }),
                };
            }

            throw new Error(`unexpected request: ${url}`);
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function answer(body: unknown, status = 200) {
        return { ok: status < 400, status, json: async () => body };
    }

    it("reads a capture's amount and fee as exact cents", async () => {
        const { chargeVaultToken } = await import(
            "@/server/payments/gateways/paypal-api"
        );

        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes("/v1/oauth2/token")) {
                return answer({ access_token: "t", expires_in: 3600 });
            }

            return answer({
                id: "ORDER-1",
                status: "COMPLETED",
                purchase_units: [
                    {
                        payments: {
                            captures: [
                                {
                                    id: "CAPTURE-1",
                                    status: "COMPLETED",
                                    amount: {
                                        value: "29.99",
                                        currency_code: "EUR",
                                    },
                                    seller_receivable_breakdown: {
                                        paypal_fee: {
                                            value: "1.07",
                                            currency_code: "EUR",
                                        },
                                    },
                                },
                            ],
                        },
                    },
                ],
            });
        });

        const capture = await chargeVaultToken({
            invoiceId: INVOICE.id,
            invoiceNumber: INVOICE.number,
            amountCents: 2999,
            currency: "EUR",
            token: "vault-1",
        });

        // `Number("29.99") * 100` is 2998.9999999999995 and `Number("1.07") *
        // 100` is 107.00000000000001. Neither goes near this path.
        expect(capture.amountCents).toBe(2999);
        expect(capture.feeCents).toBe(107);
        expect(capture.captureId).toBe("CAPTURE-1");
    });

    it("sends the amount as a decimal string built from the cents", async () => {
        const { createInvoiceOrder } = await import(
            "@/server/payments/gateways/paypal-api"
        );

        let sent: Record<string, unknown> | null = null;

        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (String(url).includes("/v1/oauth2/token")) {
                return answer({ access_token: "t", expires_in: 3600 });
            }

            sent = JSON.parse(String(init?.body));

            return answer({
                id: "ORDER-2",
                status: "PAYER_ACTION_REQUIRED",
                links: [
                    { rel: "payer-action", href: "https://paypal.test/approve" },
                ],
            });
        });

        await createInvoiceOrder({
            invoiceId: INVOICE.id,
            invoiceNumber: INVOICE.number,
            amountCents: 2999,
            currency: "EUR",
            attempt: 1,
        });

        const unit = (
            sent as unknown as {
                purchase_units: {
                    amount: { value: string };
                    invoice_id: string;
                }[];
            }
        ).purchase_units[0];

        expect(unit.amount.value).toBe("29.99");
        // Unique across the whole PayPal account — which is also what makes
        // PayPal refuse a second payment for the same invoice.
        expect(unit.invoice_id).toBe("RE-2026-0012");
    });

    it("carries the provider's issue through, so a double capture is recognisable", async () => {
        const { captureOrder, paypalIssue } = await import(
            "@/server/payments/gateways/paypal-api"
        );

        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes("/v1/oauth2/token")) {
                return answer({ access_token: "t", expires_in: 3600 });
            }

            return answer(
                {
                    name: "UNPROCESSABLE_ENTITY",
                    details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
                },
                422,
            );
        });

        const error = await captureOrder("ORDER-3").catch((one) => one);

        expect(paypalIssue(error)).toBe("ORDER_ALREADY_CAPTURED");
    });
});

describe("a PayPal-run subscription payment", () => {
    it("reads the sale's figures without a float", async () => {
        const { readSale } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        const sale = readSale({
            id: "SALE-1",
            billing_agreement_id: "I-ABC123",
            amount: { total: "19.99", currency: "EUR" },
            transaction_fee: { value: "0.66" },
        });

        expect(sale).toEqual({
            saleId: "SALE-1",
            billingAgreementId: "I-ABC123",
            amountCents: 1999,
            feeCents: 66,
            currency: "EUR",
        });
    });

    it("refuses a sale that names no subscription", async () => {
        const { readSale } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        // Without the billing agreement there is nothing to map it to, and
        // guessing is how money lands on the wrong invoice.
        expect(
            readSale({ id: "SALE-2", amount: { total: "19.99" } }),
        ).toBeNull();
        expect(
            readSale({ billing_agreement_id: "I-ABC", amount: { total: "1" } }),
        ).toBeNull();
    });

    it("keys a plan on everything that makes it a different plan", async () => {
        const { planKey } = await import(
            "@/server/payments/gateways/paypal-subscriptions"
        );

        // The price is part of the key on purpose: reusing a plan after a
        // price change would reprice everybody already on it.
        expect(
            planKey({
                cycle: "monthly",
                unitAmountCents: 1999,
                currency: "EUR",
                mode: "live",
            }),
        ).toBe("monthly:1999:EUR:live");

        expect(
            planKey({
                cycle: "monthly",
                unitAmountCents: 2499,
                currency: "EUR",
                mode: "live",
            }),
        ).not.toBe(
            planKey({
                cycle: "monthly",
                unitAmountCents: 1999,
                currency: "EUR",
                mode: "live",
            }),
        );
    });
});
