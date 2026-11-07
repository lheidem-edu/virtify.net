import { db } from "@/db";
import { authenticate, scopedCustomerId } from "@/server/api/auth";
import { invalid, json, malformed, problem } from "@/server/api/respond";
import { storeFinalizedPdf } from "@/server/billing/invoices/pdf";
import {
    orderCreateBodySchema,
    orderItemsFromWire,
    serializeOrder,
} from "@/server/orders/api";
import { ANY_CUSTOMER, loadOrder } from "@/server/orders/repository";
import { OrderError, placeOrderFromItems } from "@/server/orders/service";

export const dynamic = "force-dynamic";

/**
 * Places an order: the same transaction the storefront's checkout runs, so
 * the subscriptions, the services and the finalized first invoice come out
 * of one code path whichever door the order came in by.
 *
 * A customer key orders for its own account and `customer_id` is ignored
 * rather than honoured, the way every other endpoint here treats it. A staff
 * key must name the account — an order has to belong to somebody.
 */
export async function POST(request: Request) {
    const auth = await authenticate(request, "orders.write");

    if (!auth.ok) {
        return auth.response;
    }

    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return malformed();
    }

    const parsed = orderCreateBodySchema.safeParse(body);

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
                items: orderItemsFromWire(parsed.data),
                paymentOption: parsed.data.payment_option,
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
        // slow renderer must not be able to roll back a number that has
        // already been handed out.
        if (placed.invoiceId) {
            await storeFinalizedPdf(db, "invoice", placed.invoiceId);
        }

        const loaded = await loadOrder(placed.orderId, ANY_CUSTOMER, true, db);

        if (!loaded) {
            // Cannot happen — the transaction committed — but reading the
            // order back is what the documented 201 body is, so there is no
            // silently different answer here.
            return problem(
                500,
                "Bestellung nicht lesbar",
                "Die Bestellung wurde angelegt, konnte aber nicht gelesen werden.",
            );
        }

        return json(serializeOrder(loaded), 201);
    } catch (error) {
        if (error instanceof OrderError) {
            return problem(422, "Bestellung nicht möglich", error.message);
        }

        throw error;
    }
}
