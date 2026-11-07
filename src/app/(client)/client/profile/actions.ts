"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requestOrigin } from "@/server/audit/request";
import { getCurrentCustomer } from "@/server/customers/current";
import { updateCustomer } from "@/server/customers/repository";
import { customerSelfPatchSchema } from "@/server/customers/schema";

export type ProfileState = {
    status: "idle" | "saved" | "error";
    message?: string;
};

/**
 * The customer's own master data. It goes through the same service and the
 * same audit entry the admin form uses — and through
 * `customerSelfPatchSchema`, which simply has no `status`, `notes` or
 * `currency` in it, so there is nothing to forget to strip.
 */
export async function updateProfile(
    _previous: ProfileState,
    data: FormData,
): Promise<ProfileState> {
    const { customer, contact, user } = await getCurrentCustomer();

    if (!contact.canBilling) {
        return {
            status: "error",
            message: "Für dieses Konto darfst du die Stammdaten nicht ändern.",
        };
    }

    const value = (name: string) => {
        const raw = data.get(name);

        return typeof raw === "string" ? raw.trim() : "";
    };

    const parsed = customerSelfPatchSchema.safeParse({
        kind: value("kind") || undefined,
        name: value("name"),
        company: value("company"),
        street: value("street"),
        postalCode: value("postalCode"),
        city: value("city"),
        country: value("country") || undefined,
        vatId: value("vatId"),
        phone: value("phone"),
    });

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ?? "Bitte prüfe deine Angaben.",
        };
    }

    await updateCustomer(
        db,
        customer.id,
        parsed.data,
        { type: "customer", id: user.id, label: contact.email },
        await requestOrigin(),
    );

    revalidatePath("/client");
    revalidatePath("/client/profile");

    return { status: "saved" };
}
