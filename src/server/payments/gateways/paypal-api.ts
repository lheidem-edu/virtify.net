import "server-only";
import { fromDecimalString, toDecimalString } from "@/lib/money";
import {
    appUrl,
    gatewayConfig,
    type PayPalCredentials,
    paypalBase,
} from "@/server/payments/settings";
import { GatewayError } from "./types";

/**
 * PayPal's REST API, called directly. There is no modern server SDK worth the
 * dependency: this is a handful of endpoints and an OAuth token.
 *
 * **Money crosses the boundary in exactly two places** — `amount()` on the
 * way out and `fromDecimalString()` on the way back — and nowhere else.
 * PayPal speaks decimal strings; we speak integer cents. `Number("19.99") *
 * 100` is 1998.9999999999998, and `Math.round` only hides that until a value
 * lands on the other side of a half.
 */

function amount(cents: number) {
    return toDecimalString(cents);
}

/** PayPal's figure, as whole cents, or null if it is not a figure. */
export function centsOf(value: string | null | undefined): number | null {
    return value ? fromDecimalString(value) : null;
}

type Token = { value: string; expiresAt: number };

/** One token per client id — a key changed in the admin area takes at once. */
const tokens = new Map<string, Token>();

export async function paypalCredentials(): Promise<{
    credentials: PayPalCredentials;
    base: string;
}> {
    const config = await gatewayConfig("paypal");

    if (!config.credentials.clientId || !config.credentials.clientSecret) {
        throw new GatewayError("paypal", "PayPal ist nicht eingerichtet.");
    }

    return {
        credentials: config.credentials,
        base: paypalBase(config.mode),
    };
}

async function accessToken(): Promise<{ token: string; base: string }> {
    const { credentials, base } = await paypalCredentials();
    const cached = tokens.get(credentials.clientId);

    if (cached && cached.expiresAt > Date.now() + 60_000) {
        return { token: cached.value, base };
    }

    const basic = Buffer.from(
        `${credentials.clientId}:${credentials.clientSecret}`,
    ).toString("base64");

    const response = await fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });

    if (!response.ok) {
        throw new GatewayError(
            "paypal",
            `PayPal lehnte die Anmeldung ab (${response.status}).`,
        );
    }

    const body = (await response.json()) as {
        access_token: string;
        expires_in: number;
    };

    tokens.set(credentials.clientId, {
        value: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1000,
    });

    return { token: body.access_token, base };
}

type PayPalError = { name?: string; details?: { issue?: string }[] };

export async function call<T>(
    path: string,
    init: { method: string; body?: unknown; requestId?: string },
): Promise<T> {
    const { token, base } = await accessToken();

    const response = await fetch(`${base}${path}`, {
        method: init.method,
        headers: {
            Authorization: `Bearer ${token}`,
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

        // The issue is carried through so callers can recognise the two that
        // are not bugs: an order captured twice, and an account without
        // reference transactions.
        throw new GatewayError(
            "paypal",
            `PayPal lehnte ${path} ab: ${issue}`,
            issue,
        );
    }

    return body as T;
}

export function paypalIssue(error: unknown): string | null {
    return error instanceof GatewayError ? error.code : null;
}

export type PayPalOrder = {
    id: string;
    status: string;
    links?: { rel: string; href: string; method?: string }[];
    purchase_units?: {
        payments?: {
            captures?: {
                id: string;
                status: string;
                amount?: { value: string; currency_code: string };
                seller_receivable_breakdown?: {
                    paypal_fee?: { value: string; currency_code: string };
                };
            }[];
        };
    }[];
};

export type PayPalCapture = {
    orderId: string;
    status: string;
    captureId: string | null;
    captureStatus: string | null;
    amountCents: number | null;
    feeCents: number | null;
};

export function readCapture(order: PayPalOrder): PayPalCapture {
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];

    return {
        orderId: order.id,
        status: order.status,
        captureId: capture?.id ?? null,
        captureStatus: capture?.status ?? null,
        amountCents: centsOf(capture?.amount?.value),
        feeCents: centsOf(
            capture?.seller_receivable_breakdown?.paypal_fee?.value,
        ),
    };
}

/** The hosted approval page for a single invoice. */
export async function createInvoiceOrder(input: {
    invoiceId: string;
    invoiceNumber: string;
    /** What the payer reads; defaults to "Rechnung {number}". */
    descriptor?: string;
    amountCents: number;
    currency: string;
    attempt: number;
    returnPath?: string;
    cancelPath?: string;
}) {
    const order = await call<PayPalOrder>("/v2/checkout/orders", {
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
                    description:
                        input.descriptor ?? `Rechnung ${input.invoiceNumber}`,
                    amount: {
                        currency_code: input.currency,
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
                        return_url: `${appUrl()}${input.returnPath ?? `/client/invoices/${input.invoiceId}/paid`}?provider=paypal`,
                        cancel_url: `${appUrl()}${input.cancelPath ?? "/client/invoices"}`,
                    },
                },
            },
        },
    });

    const approve = order.links?.find(
        (link) => link.rel === "payer-action" || link.rel === "approve",
    );

    if (!approve) {
        throw new GatewayError("paypal", "PayPal lieferte keine Adresse.");
    }

    return { id: order.id, url: approve.href };
}

/**
 * Takes the money after the customer approved. Capturing twice is not a
 * mistake worth failing on — PayPal answers ORDER_ALREADY_CAPTURED and the
 * first capture stands, so the caller treats that as success.
 */
export async function captureOrder(orderId: string) {
    return readCapture(
        await call<PayPalOrder>(`/v2/checkout/orders/${orderId}/capture`, {
            method: "POST",
            requestId: `capture:${orderId}`,
        }),
    );
}

export async function readOrder(orderId: string) {
    return readCapture(
        await call<PayPalOrder>(`/v2/checkout/orders/${orderId}`, {
            method: "GET",
        }),
    );
}

/**
 * Storing a PayPal wallet for later merchant-initiated charges. Gated by the
 * gateway setting: the account has to be approved for reference transactions
 * first, and without that approval every charge fails with
 * MERCHANT_NOT_ENABLED_FOR_REFERENCE_TRANSACTION.
 */
export async function createVaultSetupToken(input: { customerId: string }) {
    const setup = await call<{
        id: string;
        links?: { rel: string; href: string }[];
    }>("/v3/vault/setup-tokens", {
        method: "POST",
        requestId: `vault:${input.customerId}:${Date.now()}`,
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
                        return_url: `${appUrl()}/client/payment-methods?provider=paypal`,
                        cancel_url: `${appUrl()}/client/payment-methods`,
                    },
                },
            },
        },
    });

    const approve = setup.links?.find((link) => link.rel === "approve");

    if (!approve) {
        throw new GatewayError("paypal", "PayPal lieferte keine Adresse.");
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
    currency: string;
    token: string;
}) {
    const order = await call<PayPalOrder>("/v2/checkout/orders", {
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
                        currency_code: input.currency,
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

/** Sends part or all of a capture back. */
export async function refundCapture(input: {
    captureId: string;
    amountCents: number;
    currency: string;
    attempt: number;
}) {
    const refund = await call<{
        id: string;
        status: string;
        amount?: { value: string; currency_code: string };
    }>(`/v2/payments/captures/${input.captureId}/refund`, {
        method: "POST",
        requestId: `refund:${input.captureId}:${input.attempt}`,
        body: {
            amount: {
                currency_code: input.currency,
                value: amount(input.amountCents),
            },
        },
    });

    return {
        id: refund.id,
        status: refund.status,
        amountCents: centsOf(refund.amount?.value) ?? input.amountCents,
    };
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
}): Promise<boolean> {
    const { credentials } = await paypalCredentials();

    if (!credentials.webhookId) {
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
                webhook_id: credentials.webhookId,
                webhook_event: JSON.parse(input.rawBody),
            },
        },
    );

    return result.verification_status === "SUCCESS";
}
