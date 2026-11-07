"use server";

import { APIError } from "better-auth/api";
import { z } from "zod";
import { db } from "@/db";
import { auth } from "@/server/auth/auth";
import { customerForUser, updateCustomer } from "@/server/customers/repository";

export type RegisterState = {
    status: "idle" | "sent" | "error";
    message?: string;
    /** The address the confirmation went to, for the page to name it back. */
    email?: string;
};

const MIN_PASSWORD_LENGTH = 12;

const schema = z.object({
    name: z.string().trim().min(1, "Bitte gib deinen Namen an.").max(200),
    email: z.email("Das sieht nicht nach einer E-Mail-Adresse aus."),
    password: z
        .string()
        .min(
            MIN_PASSWORD_LENGTH,
            `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`,
        ),
    kind: z.enum(["private", "company"]).default("private"),
    company: z.string().trim().max(200).optional(),
    country: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, "Zwei Buchstaben nach ISO 3166-1, z. B. DE.")
        .default("DE"),
    vatId: z.string().trim().max(32).optional(),
});

/**
 * Sign-up on the server rather than from the browser, because an account is
 * two things now: a login and the billing account behind it. Better Auth
 * writes the first and its create hook writes the second; what is left here
 * is the master data the form collected, applied to the account that hook
 * made.
 */
export async function registerAccount(
    _previous: RegisterState,
    data: FormData,
): Promise<RegisterState> {
    /**
     * `FormData.get` answers `null` for a field the form did not render, and
     * an optional zod string does not accept `null` — so a caller that
     * leaves out the company field gets "expected string, received null"
     * instead of a registration. The checkout's inline sign-up renders only
     * name, address and password, which is exactly that case.
     */
    const field = (name: string) => data.get(name) ?? undefined;

    const parsed = schema.safeParse({
        name: field("name"),
        email: field("email"),
        password: field("password"),
        kind: String(data.get("kind") ?? "private"),
        company: field("company"),
        country: String(data.get("country") ?? "DE") || "DE",
        vatId: field("vatId"),
    });

    if (!parsed.success) {
        return {
            status: "error",
            message:
                parsed.error.issues[0]?.message ?? "Bitte prüfe deine Angaben.",
        };
    }

    const input = parsed.data;

    let userId: string;

    try {
        const result = await auth.api.signUpEmail({
            body: {
                name: input.name,
                email: input.email,
                password: input.password,
            },
        });

        userId = result.user.id;
    } catch (error) {
        if (error instanceof APIError) {
            return {
                status: "error",
                message:
                    error.body?.message ??
                    "Die Registrierung hat nicht geklappt.",
            };
        }

        console.error("[auth] sign-up failed:", error);

        return {
            status: "error",
            message:
                "Die Registrierung hat nicht geklappt. Bitte versuche es später erneut.",
        };
    }

    // The login exists either way from here on; failing to store the master
    // data must not look like a failed registration, because the customer
    // already has a confirmation mail in their inbox.
    try {
        const row = await customerForUser(db, userId);

        if (row) {
            await updateCustomer(
                db,
                row.customer.id,
                {
                    kind: input.kind,
                    company: input.kind === "company" ? input.company : null,
                    country: input.country,
                    vatId: input.vatId || null,
                },
                { type: "customer", id: userId, label: input.email },
            );
        }
    } catch (error) {
        console.error("[auth] storing the new account's master data:", error);
    }

    return { status: "sent", email: input.email };
}
