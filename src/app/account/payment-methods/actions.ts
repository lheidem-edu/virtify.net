"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/lib/mail";
import { paypalConfig, stripeEnabled } from "@/lib/payments/config";
import { createVaultSetupToken, deleteVaultToken } from "@/lib/payments/paypal";
import {
    createSetupCheckout,
    detachStoredMethod,
    ensureStripeCustomer,
} from "@/lib/payments/stripe";
import { operator } from "@/lib/site";

export type PaymentMethodState = {
    status: "idle" | "removed" | "changed" | "error";
    message?: string;
};

/**
 * Sends the customer to the provider's hosted setup page. Nothing is stored
 * here — the row is written when the customer comes back, because only then
 * does a token exist that we may actually collect from.
 */
export async function startPaymentMethodSetup(
    _previous: PaymentMethodState,
    data: FormData,
): Promise<PaymentMethodState> {
    const session = await requireSession();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const provider = read("provider");
    /** Set when the setup started from a contract that should collect from it. */
    const contractId = read("contractId");

    if (provider !== "stripe" && provider !== "paypal") {
        return { status: "error", message: "Unbekannte Zahlungsart." };
    }

    if (provider === "stripe" && !stripeEnabled()) {
        return {
            status: "error",
            message: "Diese Zahlungsart steht gerade nicht zur Verfügung.",
        };
    }

    if (provider === "paypal" && !paypalConfig.vaulting) {
        return {
            status: "error",
            message:
                "PayPal lässt sich derzeit nicht als Zahlungsmittel hinterlegen.",
        };
    }

    if (contractId) {
        const [contract] = await db
            .select({ id: schema.contract.id })
            .from(schema.contract)
            .where(
                and(
                    eq(schema.contract.id, contractId),
                    eq(schema.contract.userId, session.user.id),
                ),
            );

        if (!contract) {
            return {
                status: "error",
                message: "Diesen Vertrag gibt es nicht.",
            };
        }
    }

    let url: string;

    try {
        if (provider === "stripe") {
            const [row] = await db
                .select()
                .from(schema.user)
                .where(eq(schema.user.id, session.user.id));

            const stripeCustomerId = await ensureStripeCustomer(row);

            // Keep the customer id on our side: the next setup and every
            // collection has to reach the same Stripe customer.
            if (row.stripeCustomerId !== stripeCustomerId) {
                await db
                    .update(schema.user)
                    .set({ stripeCustomerId, updatedAt: new Date() })
                    .where(eq(schema.user.id, session.user.id));
            }

            const setup = await createSetupCheckout({
                userId: session.user.id,
                stripeCustomerId,
                contractId: contractId || undefined,
            });

            await recordSetup(setup.id, session.user.id, "stripe", contractId);
            url = setup.url;
        } else {
            const setup = await createVaultSetupToken({
                userId: session.user.id,
            });

            await recordSetup(setup.id, session.user.id, "paypal", contractId);
            url = setup.url;
        }
    } catch (error) {
        console.error("[payment] starting method setup failed:", error);

        return {
            status: "error",
            message:
                "Das Hinterlegen konnte nicht gestartet werden. Bitte versuche es erneut.",
        };
    }

    // redirect() works by throwing, so it must sit outside the try above.
    redirect(url);
}

/**
 * Written before the customer leaves, so the identifier they come back with
 * means something. Both providers return to a URL anyone could type, carrying
 * an id anyone could present — this row is what makes it this account's.
 */
async function recordSetup(
    id: string,
    userId: string,
    provider: "stripe" | "paypal",
    contractId: string,
) {
    await db
        .insert(schema.paymentSetup)
        .values({ id, userId, provider, contractId: contractId || null })
        .onConflictDoNothing();
}

/**
 * Withdrawing a stored method. The provider is told first; whether it
 * confirms or not, the local row is revoked and every contract that collected
 * from it falls back to manual payment — the row is what we bill from, so a
 * token left behind at the provider is never used again.
 */
export async function removePaymentMethod(
    _previous: PaymentMethodState,
    data: FormData,
): Promise<PaymentMethodState> {
    const session = await requireSession();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const methodId = read("methodId");

    const [method] = await db
        .select()
        .from(schema.paymentMethod)
        .where(
            and(
                eq(schema.paymentMethod.id, methodId),
                eq(schema.paymentMethod.userId, session.user.id),
                isNull(schema.paymentMethod.revokedAt),
            ),
        );

    if (!method) {
        return {
            status: "error",
            message: "Dieses Zahlungsmittel ist nicht mehr hinterlegt.",
        };
    }

    // Fallible, so it runs on its own before the transaction below. Whether
    // it worked is remembered rather than assumed: withdrawing the
    // authorisation here always succeeds and is what stops us collecting, but
    // the deletion at the provider is what the customer was promised.
    let detachedAt: Date | null = new Date();

    try {
        if (method.provider === "stripe") {
            await detachStoredMethod(method.token);
        } else {
            await deleteVaultToken(method.token);
        }
    } catch (error) {
        console.error("[payment] detaching stored method failed:", error);
        detachedAt = null;
    }

    try {
        await db.transaction(async (tx) => {
            await tx
                .update(schema.paymentMethod)
                .set({ revokedAt: new Date(), detachedAt })
                .where(eq(schema.paymentMethod.id, methodId));

            await tx
                .update(schema.contract)
                .set({ paymentMethodId: null, updatedAt: new Date() })
                .where(
                    and(
                        eq(schema.contract.paymentMethodId, methodId),
                        eq(schema.contract.userId, session.user.id),
                    ),
                );
        });
    } catch (error) {
        console.error("[payment] revoking stored method failed:", error);

        return {
            status: "error",
            message:
                "Das Zahlungsmittel konnte nicht entfernt werden. Bitte versuche es erneut.",
        };
    }

    if (!detachedAt) {
        await notifyDetachFailed({
            label: method.label,
            provider: method.provider,
            token: method.token,
        });
    }

    revalidatePath("/account/payment-methods");
    revalidatePath("/account/contracts");

    return {
        status: "removed",
        message: detachedAt
            ? "Das Zahlungsmittel ist entfernt und beim Zahlungsdienstleister gelöscht."
            : "Das Zahlungsmittel ist entfernt und wird nicht mehr verwendet. Die Löschung beim Zahlungsdienstleister konnte gerade nicht bestätigt werden; wir holen sie nach.",
    };
}

/**
 * The customer is told the withdrawal worked, because it did — we will never
 * collect from it again. The half that did not work is the operator's to
 * finish at the provider, so it goes to them.
 */
async function notifyDetachFailed(input: {
    label: string;
    provider: string;
    token: string;
}) {
    const transport = createTransport();

    if (!transport) {
        console.error("[payment] detach failed and no transport:", input);
        return;
    }

    try {
        await transport.sendMail({
            from: mailFrom,
            to: operator.email,
            subject: `Zahlungsmittel nicht gelöscht — ${input.provider}`,
            text: [
                `Ein Kunde hat „${input.label}“ entfernt. Der Widerruf ist hier wirksam, aber ${input.provider} hat die Löschung des Tokens nicht bestätigt.`,
                "",
                `Token: ${input.token}`,
                "",
                "Bitte im Konto des Anbieters nachziehen.",
            ].join("\n"),
            html: renderEmail({
                preheader: `Löschung bei ${input.provider} nicht bestätigt.`,
                heading: "Zahlungsmittel nicht gelöscht",
                intro: [
                    `Ein Kunde hat „${input.label}“ entfernt. Der Widerruf ist hier wirksam und es wird nichts mehr eingezogen, aber ${input.provider} hat die Löschung des Tokens nicht bestätigt. Bitte im Konto des Anbieters nachziehen.`,
                ],
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Zahlungsmittel", value: input.label },
                    { label: "Anbieter", value: input.provider },
                    { label: "Token", value: input.token },
                ],
            }),
        });
    } catch (error) {
        logMailError("detach failure notice", error);
    }
}

/**
 * Switches automatic collection for one contract on or off. Switching it on
 * is the customer's authorisation to collect that contract's invoices from
 * the chosen method, so both the contract and the method are re-checked here
 * rather than trusted from the form.
 */
export async function setContractCollection(
    _previous: PaymentMethodState,
    data: FormData,
): Promise<PaymentMethodState> {
    const session = await requireSession();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const contractId = read("contractId");
    const methodId = read("methodId");
    const mode = read("mode");

    if (mode !== "on" && mode !== "off") {
        return { status: "error", message: "Unbekannte Aktion." };
    }

    if (mode === "on" && !methodId) {
        return { status: "error", message: "Bitte wähle ein Zahlungsmittel." };
    }

    try {
        await db.transaction(async (tx) => {
            const [contract] = await tx
                .select()
                .from(schema.contract)
                .where(
                    and(
                        eq(schema.contract.id, contractId),
                        eq(schema.contract.userId, session.user.id),
                    ),
                )
                .for("update");

            if (!contract) {
                throw new Error("not-found");
            }

            // Withdrawing comes first and is never refused: § 7 (8) of the
            // terms promises it can be done at any time, and a contract that
            // has since been terminated is exactly when someone wants to.
            if (mode === "off") {
                await tx
                    .update(schema.contract)
                    .set({ paymentMethodId: null, updatedAt: new Date() })
                    .where(eq(schema.contract.id, contractId));
                return;
            }

            // Switching it on is a different matter: a terminated or ended
            // contract produces no further invoices, so there is nothing to
            // collect and nothing to authorise.
            if (
                contract.status !== "provisioning" &&
                contract.status !== "active"
            ) {
                throw new Error("not-open");
            }

            const [method] = await tx
                .select({ id: schema.paymentMethod.id })
                .from(schema.paymentMethod)
                .where(
                    and(
                        eq(schema.paymentMethod.id, methodId),
                        eq(schema.paymentMethod.userId, session.user.id),
                        isNull(schema.paymentMethod.revokedAt),
                    ),
                );

            if (!method) {
                throw new Error("method-unknown");
            }

            await tx
                .update(schema.contract)
                .set({ paymentMethodId: method.id, updatedAt: new Date() })
                .where(eq(schema.contract.id, contractId));
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        console.error("[payment] changing contract collection failed:", error);

        return {
            status: "error",
            message:
                reason === "not-open"
                    ? "Für diesen Vertrag stellen wir keine Rechnungen mehr aus."
                    : reason === "method-unknown"
                      ? "Dieses Zahlungsmittel ist nicht mehr hinterlegt."
                      : reason === "not-found"
                        ? "Diesen Vertrag gibt es nicht."
                        : "Das hat nicht geklappt. Bitte versuche es erneut.",
        };
    }

    revalidatePath("/account/contracts");
    revalidatePath("/account/payment-methods");

    return { status: "changed" };
}
