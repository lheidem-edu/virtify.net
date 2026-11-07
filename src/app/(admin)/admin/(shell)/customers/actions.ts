"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requestOrigin } from "@/server/audit/request";
import { requirePermission } from "@/server/auth/staff-session";
import { createCustomer, updateCustomer } from "@/server/customers/repository";
import { customerInputSchema } from "@/server/customers/schema";

export type CustomerState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

/** Form values come in as strings; the schema turns them into the real shape. */
function read(data: FormData) {
    const value = (name: string) => {
        const raw = data.get(name);

        return typeof raw === "string" ? raw.trim() : undefined;
    };

    return {
        kind: value("kind") || undefined,
        name: value("name") ?? "",
        company: value("company") ?? "",
        street: value("street") ?? "",
        postalCode: value("postalCode") ?? "",
        city: value("city") ?? "",
        country: value("country") || undefined,
        vatId: value("vatId") ?? "",
        phone: value("phone") ?? "",
        buyerReference: value("buyerReference") ?? "",
        language: value("language") || undefined,
        status: value("status") || undefined,
        notes: value("notes") ?? "",
    };
}

/**
 * Corrects a customer's master data. The e-mail address is deliberately not
 * here: it is a contact's login and is only ever changed by the customer with
 * confirmation.
 */
export async function saveCustomer(
    _previous: CustomerState,
    data: FormData,
): Promise<CustomerState> {
    const session = await requirePermission("customers.write");

    const customerId = String(data.get("customerId") ?? "");

    if (!customerId) {
        return { status: "error", message: "Kein Konto angegeben." };
    }

    const parsed = customerInputSchema.partial().safeParse(read(data));

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    const row = await updateCustomer(
        db,
        customerId,
        parsed.data,
        {
            type: "staff",
            id: session.user.id,
            label: session.user.email,
        },
        await requestOrigin(),
    );

    if (!row) {
        return { status: "error", message: "Dieses Konto gibt es nicht." };
    }

    revalidatePath("/admin/customers");
    revalidatePath(`/admin/customers/${customerId}`);

    return { status: "saved" };
}

/**
 * Creates a billing account without a login — for taking on an existing
 * customer, or for one the operator bills without giving them the portal.
 * A contact can be attached later.
 */
export async function addCustomer(
    _previous: CustomerState,
    data: FormData,
): Promise<CustomerState> {
    const session = await requirePermission("customers.write");

    const parsed = customerInputSchema.safeParse(read(data));

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ??
                "Die Angaben sind nicht vollständig.",
        };
    }

    const row = await createCustomer(
        db,
        parsed.data,
        {
            type: "staff",
            id: session.user.id,
            label: session.user.email,
        },
        await requestOrigin(),
    );

    revalidatePath("/admin/customers");

    // Outside the try/catch above by construction: redirect() throws.
    redirect(`/admin/customers/${row.id}`);
}
