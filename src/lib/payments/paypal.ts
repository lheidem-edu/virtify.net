import "server-only";
import { appUrl, paypalConfig, paypalEnabled } from "@/lib/payments/config";

/**
 * PayPal's REST API, called directly. There is no modern server SDK worth the
 * dependency: this is four endpoints and an OAuth token.
 *
 * Money is a decimal string on PayPal's side and integer cents on ours, so it
 * crosses the boundary in exactly one place — `amount()` — and nowhere else.
 */

function amount(cents: number) {
    return (cents / 100).toFixed(2);
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken() {
    if (!paypalEnabled()) {
        throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
    }

    if (token && token.expiresAt > Date.now() + 60_000) {
        return token.value;
    }

    const credentials = Buffer.from(
        `${paypalConfig.clientId}:${paypalConfig.clientSecret}`,
    ).toString("base64");

    const response = await fetch(`${paypalConfig.base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });

    if (!response.ok) {
        throw new Error(`PayPal token request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
        access_token: string;
        expires_in: number;
    };

    token = {
        value: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1000,
    };

    return token.value;
}

type PayPalError = { name?: string; details?: { issue?: string }[] };

async function call<T>(
    path: string,
    init: { method: string; body?: unknown; requestId?: string },
) {
    const response = await fetch(`${paypalConfig.base}${path}`, {
        method: init.method,
        headers: {
            Authorization: `Bearer ${await accessToken()}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
            ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
    });

    if (response.status === 204) {
        return null as T;
    }

    const body = (await response.json().catch(() => null)) as T & PayPalError;

    if (!response.ok) {
        const issue = body?.details?.[0]?.issue ?? body?.name ?? "unknown";
        const error = new Error(`PayPal ${path} failed: ${issue}`);
        // Carried through so callers can recognise the two that are not bugs:
        // an order captured twice, and an account without reference
        // transactions.
        (error as Error & { issue?: string }).issue = issue;
        throw error;
    }

    return body as T;
}

export function paypalIssue(error: unknown) {
    return error instanceof Error
        ? ((error as Error & { issue?: string }).issue ?? null)
        : null;
}

type Order = {
    id: string;
    status: string;
    links?: { rel: string; href: string; method?: string }[];
    purchase_units?: {
        payments?: {
            captures?: {
                id: string;
                status: string;
                seller_receivable_breakdown?: {
                    paypal_fee?: { value: string; currency_code: string };
                };
            }[];
        };
    }[];
};

/** The hosted approval page for a single invoice. */
export async function createInvoiceOrder(input: {
    invoiceId: string;
    invoiceNumber: string;
    amountCents: number;
    attempt: number;
}) {
    const order = await call<Order>("/v2/checkout/orders", {
        method: "POST",
        requestId: `invoice:${input.invoiceId}:attempt:${input.attempt}`,
        body: {
            intent: "CAPTURE",
            purchase_units: [
                {
                    // Unique across the whole PayPal account — our gapless
                    // RE- series is exactly that, which is also what makes
                    // PayPal refuse a second payment for the same invoice.
                    invoice_id: input.invoiceNumber,
                    custom_id: input.invoiceId,
                    description: `Rechnung ${input.invoiceNumber}`,
                    amount: {
                        currency_code: "EUR",
                        value: amount(input.amountCents),
                    },
                },
            ],
            payment_source: {
                paypal: {
                    experience_context: {
                        brand_name: "virtify.net",
                        locale: "de-DE",
                        user_action: "PAY_NOW",
                        return_url: `${appUrl()}/account/invoices/${input.invoiceId}/paid?provider=paypal`,
                        cancel_url: `${appUrl()}/account/invoices`,
                    },
                },
            },
        },
    });

    const approve = order.links?.find(
        (link) => link.rel === "payer-action" || link.rel === "approve",
    );

    if (!approve) {
        throw new Error("PayPal returned no approval link");
    }

    return { id: order.id, url: approve.href };
}

/**
 * Takes the money after the customer approved. Capturing twice is not a
 * mistake worth failing on — PayPal answers ORDER_ALREADY_CAPTURED and the
 * first capture stands, so the caller treats that as success.
 */
export async function captureOrder(orderId: string) {
    const order = await call<Order>(`/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        requestId: `capture:${orderId}`,
    });

    return readCapture(order);
}

export async function readOrder(orderId: string) {
    return readCapture(
        await call<Order>(`/v2/checkout/orders/${orderId}`, {
            method: "GET",
        }),
    );
}

function readCapture(order: Order) {
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    const fee = capture?.seller_receivable_breakdown?.paypal_fee?.value;

    return {
        orderId: order.id,
        status: order.status,
        captureId: capture?.id ?? null,
        captureStatus: capture?.status ?? null,
        feeCents: fee ? Math.round(Number(fee) * 100) : null,
    };
}

/**
 * Storing a PayPal wallet for later merchant-initiated charges. Gated by
 * config: the account has to be approved for reference transactions first,
 * and without that approval every charge fails with
 * MERCHANT_NOT_ENABLED_FOR_REFERENCE_TRANSACTION.
 */
export async function createVaultSetupToken(input: { userId: string }) {
    const setup = await call<{
        id: string;
        links?: { rel: string; href: string }[];
    }>("/v3/vault/setup-tokens", {
        method: "POST",
        requestId: `vault:${input.userId}:${Date.now()}`,
        body: {
            payment_source: {
                paypal: {
                    description: "virtify.net — wiederkehrende Zahlungen",
                    usage_type: "MERCHANT",
                    customer_type: "CONSUMER",
                    permit_multiple_payment_tokens: false,
                    usage_pattern: "SUBSCRIPTION_PREPAID",
                    experience_context: {
                        brand_name: "virtify.net",
                        locale: "de-DE",
                        return_url: `${appUrl()}/account/payment-methods?provider=paypal`,
                        cancel_url: `${appUrl()}/account/payment-methods`,
                    },
                },
            },
        },
    });

    const approve = setup.links?.find((link) => link.rel === "approve");

    if (!approve) {
        throw new Error("PayPal returned no vault approval link");
    }

    return { id: setup.id, url: approve.href };
}

export async function createVaultPaymentToken(setupTokenId: string) {
    const created = await call<{
        id: string;
        customer?: { id: string };
        payment_source?: { paypal?: { email_address?: string } };
    }>("/v3/vault/payment-tokens", {
        method: "POST",
        requestId: `token:${setupTokenId}`,
        body: {
            payment_source: {
                token: { id: setupTokenId, type: "SETUP_TOKEN" },
            },
        },
    });

    const email = created.payment_source?.paypal?.email_address;

    return {
        token: created.id,
        customerId: created.customer?.id ?? null,
        label: email ? `PayPal, ${email}` : "PayPal",
    };
}

export async function deleteVaultToken(tokenId: string) {
    await call(`/v3/vault/payment-tokens/${tokenId}`, { method: "DELETE" });
}

/** Charges a stored wallet with nobody present. */
export async function chargeVaultToken(input: {
    invoiceId: string;
    invoiceNumber: string;
    amountCents: number;
    token: string;
}) {
    const order = await call<Order>("/v2/checkout/orders", {
        method: "POST",
        requestId: `collect:${input.invoiceId}`,
        body: {
            intent: "CAPTURE",
            purchase_units: [
                {
                    invoice_id: input.invoiceNumber,
                    custom_id: input.invoiceId,
                    description: `Rechnung ${input.invoiceNumber}`,
                    amount: {
                        currency_code: "EUR",
                        value: amount(input.amountCents),
                    },
                },
            ],
            payment_source: {
                paypal: {
                    vault_id: input.token,
                    stored_credential: {
                        payment_initiator: "MERCHANT",
                        payment_type: "RECURRING",
                        usage: "SUBSEQUENT",
                    },
                },
            },
        },
    });

    return readCapture(order);
}

/**
 * PayPal has no signing secret; the webhook is authenticated by handing the
 * headers and the untouched body back to PayPal. The body must be the exact
 * string that arrived — re-serialising the JSON changes it and the check
 * fails for reasons the error never explains.
 */
export async function verifyWebhook(input: {
    headers: Headers;
    rawBody: string;
}) {
    if (!paypalConfig.webhookId) {
        return false;
    }

    const header = (name: string) => input.headers.get(name) ?? "";

    const result = await call<{ verification_status: string }>(
        "/v1/notifications/verify-webhook-signature",
        {
            method: "POST",
            body: {
                auth_algo: header("paypal-auth-algo"),
                cert_url: header("paypal-cert-url"),
                transmission_id: header("paypal-transmission-id"),
                transmission_sig: header("paypal-transmission-sig"),
                transmission_time: header("paypal-transmission-time"),
                webhook_id: paypalConfig.webhookId,
                webhook_event: JSON.parse(input.rawBody),
            },
        },
    );

    return result.verification_status === "SUCCESS";
}
