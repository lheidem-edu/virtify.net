import { db } from "@/db";
import type { SubscriptionStatus } from "@/db/schema";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { invalid, json, malformed, problem } from "@/server/api/respond";
import { storeFinalizedPdf } from "@/server/billing/invoices/pdf";
import { OrderError, placeOrderFromItems } from "@/server/orders/service";
import {
    serializeSubscription,
    serializeSubscriptionRow,
    subscriptionCreateBodySchema,
} from "@/server/subscriptions/api";
import {
    ANY_CUSTOMER,
    listSubscriptions,
    loadSubscription,
} from "@/server/subscriptions/repository";

export const dynamic = "force-dynamic";

const STATUSES: SubscriptionStatus[] = [
    "trialing",
    "active",
    "past_due",
    "paused",
    "cancelled",
    "ended",
];

/**
 * The Abos, seitenweise. A customer key sees its own and `customer_id` is
 * overwritten for it rather than honoured — the same rule every list here
 * follows.
 */
export async function GET(request: Request) {
    const auth = await authenticate(request, "subscriptions.read");

    if (!auth.ok) {
        return auth.response;
    }

    const url = new URL(request.url);
    const own = scopedCustomerId(auth.context);
    const status = STATUSES.find(
        (entry) => entry === url.searchParams.get("status"),
    );
    const limit = Number(url.searchParams.get("limit") ?? "");

    const page = await listSubscriptions(
        own ?? ANY_CUSTOMER,
        own === null,
        {
            status,
            customerId: url.searchParams.get("customer_id") ?? undefined,
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        },
        db,
    );

    return json({
        data: page.rows.map(serializeSubscriptionRow),
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
    });
}

/**
 * Creates an Abo.
 *
 * It goes through `placeOrderFromItems` — the very same transaction the
 * storefront's checkout runs — rather than writing subscription rows of its
 * own. That is the point: an Abo comes into being in exactly one place, with
 * one set of rules about what it costs, what gets provisioned and which
 * invoice is raised for it. A second creation path would be a second answer
 * to "what does this cost", and the one that disagreed with the invoice
 * would be the one the customer had agreed to.
 *
 * The order it creates is returned only by way of the subscription; use
 * `POST /api/v1/orders` when the order itself is what matters.
 */
export async function POST(request: Request) {
    const auth = await authenticate(request, "subscriptions.write");

    if (!auth.ok) {
        return auth.response;
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    const parsed = subscriptionCreateBodySchema.safeParse(body);

    if (!parsed.success) {
        return invalid(parsed.error);
    }

    const own = scopedCustomerId(auth.context);
    const customerId = own ?? parsed.data.customer_id ?? null;

    if (!customerId) {
        return problem(
            422,
            "Eingabe ungültig",
            "Ein Mitarbeiterschlüssel muss `customer_id` angeben.",
        );
    }

    try {
        const placed = await placeOrderFromItems(
            db,
            {
                customerId,
                items: parsed.data.items.map((item) => ({
                    productId: item.product_id,
                    cycle: parsed.data.cycle,
                    currency: parsed.data.currency,
                    quantity: item.quantity,
                    options: item.options.map((option) => ({
                        optionId: option.option_id,
                        valueId: option.value_id,
                        quantity: option.quantity,
                    })),
                    couponCode: parsed.data.coupon_code ?? null,
                })),
                paymentOption: "bank_transfer",
                autoCharge: parsed.data.auto_charge,
                acceptance: {
                    terms: parsed.data.accept_terms,
                    withdrawal: parsed.data.accept_withdrawal,
                    immediateStart: parsed.data.request_immediate_start,
                },
                note: parsed.data.note ?? null,
                ip: request.headers.get("x-forwarded-for"),
                userAgent: request.headers.get("user-agent"),
            },
            {
                type: "api",
                id: auth.context.key.id,
                label: auth.context.key.prefix,
            },
        );

        // After the commit, never inside it: rendering holds no lock, and a
        // slow renderer must not roll back a number already handed out.
        if (placed.invoiceId) {
            await storeFinalizedPdf(db, "invoice", placed.invoiceId);
        }

        const id = placed.subscriptionIds[0];

        if (!id) {
            return problem(
                422,
                "Kein Abo entstanden",
                "Diese Position begründet kein wiederkehrendes Abo. " +
                    "Für einen einmaligen Verkauf ist `POST /api/v1/orders` der richtige Weg.",
            );
        }

        const loaded = await loadSubscription(id, ANY_CUSTOMER, true, db);

        if (!loaded) {
            return problem(
                500,
                "Abo nicht lesbar",
                "Das Abo wurde angelegt, konnte aber nicht gelesen werden.",
            );
        }

        return json(serializeSubscription(loaded), 201);
    } catch (error) {
        if (error instanceof OrderError) {
            return problem(422, "Abo nicht möglich", error.message);
        }

        throw error;
    }
}
