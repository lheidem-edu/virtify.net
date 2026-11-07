"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { getSession } from "@/server/auth/session";
import { storeFinalizedPdf } from "@/server/billing/invoices/pdf";
import { currentCart } from "@/server/cart/session";
import { customerForUser, updateCustomer } from "@/server/customers/repository";
import { customerSelfPatchSchema } from "@/server/customers/schema";
import { OrderError, placeOrder } from "@/server/orders/service";

/**
 * The checkout's one write.
 *
 * It does two things in order: store the billing address the customer just
 * confirmed, then place the order. The address goes first because the
 * invoice the order is about to issue carries it (§ 14 Abs. 4 Nr. 1 UStG),
 * and because a failed order should still leave a corrected address behind
 * rather than asking for it again.
 *
 * Everything about *what it costs* happens inside `placeOrder`, from the
 * catalog, in one transaction. Nothing posted by this form is a price, a
 * product id outside the cart, or a customer id: the cart comes from the
 * cookie and the account from the session.
 */

export type CheckoutState = {
    status: "idle" | "error";
    message?: string;
    /** Which field the message is about, where it is about one. */
    field?: string;
};

export async function submitOrder(
    _previous: CheckoutState,
    data: FormData,
): Promise<CheckoutState> {
    const session = await getSession();

    if (!session) {
        return {
            status: "error",
            message: "Bitte melden Sie sich an, um zu bestellen.",
        };
    }

    const account = await customerForUser(db, session.user.id);

    if (!account) {
        return {
            status: "error",
            message: "Zu dieser Anmeldung gehört kein Kundenkonto.",
        };
    }

    const cart = await currentCart();

    if (!cart) {
        return { status: "error", message: "Der Warenkorb ist leer." };
    }

    const address = customerSelfPatchSchema.safeParse({
        kind: String(data.get("kind") ?? "private"),
        name: data.get("name"),
        company: data.get("company"),
        street: data.get("street"),
        postalCode: data.get("postalCode"),
        city: data.get("city"),
        country: String(data.get("country") ?? "DE").toUpperCase() || "DE",
        vatId: data.get("vatId"),
        phone: data.get("phone"),
    });

    if (!address.success) {
        const issue = address.error.issues[0];

        return {
            status: "error",
            message: issue?.message ?? "Bitte prüfen Sie Ihre Angaben.",
            field: issue?.path.join("."),
        };
    }

    const actor = {
        type: "customer" as const,
        id: session.user.id,
        label: session.user.email,
    };

    const origin = await headers();

    await updateCustomer(db, account.customer.id, address.data, actor, {
        ip: origin.get("x-forwarded-for"),
        userAgent: origin.get("user-agent"),
    });

    let orderId: string;
    let invoiceId: string | null;

    try {
        const placed = await placeOrder(
            db,
            {
                cartId: cart.id,
                customerId: account.customer.id,
                paymentOption: "bank_transfer",
                autoCharge: data.get("autoCharge") === "on",
                acceptance: {
                    termsLabel: String(data.get("termsLabel") ?? "") || null,
                    terms: data.get("acceptTerms") === "on",
                    withdrawal: data.get("acceptWithdrawal") === "on",
                    immediateStart: data.get("immediateStart") === "on",
                },
                ip: origin.get("x-forwarded-for"),
                userAgent: origin.get("user-agent"),
            },
            actor,
        );

        orderId = placed.orderId;
        invoiceId = placed.invoiceId;
    } catch (error) {
        if (error instanceof OrderError) {
            return { status: "error", message: error.message };
        }

        throw error;
    }

    // After the commit: rendering the PDF must not be able to roll back a
    // number that has already been handed out. A failure here is logged and
    // the document is produced again on first request.
    if (invoiceId) {
        await storeFinalizedPdf(db, "invoice", invoiceId);
    }

    redirect(`/client/orders/${orderId}`);
}
