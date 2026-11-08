"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { getCurrentCustomer } from "@/server/customers/current";
import {
    logMailError,
    mailFrom,
    mailTransport,
    renderEmail,
} from "@/server/mail";
import { gateway } from "@/server/payments/gateways";
import { deleteVaultToken } from "@/server/payments/gateways/paypal-api";
import {
    detachStoredMethod,
    ensureStripeCustomer,
} from "@/server/payments/gateways/stripe";
import {
    markDetached,
    recordSetup,
    revokeMethod,
    setDefaultMethod,
} from "@/server/payments/methods";
import { loadSettings } from "@/server/settings";

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
    const { customer, contact } = await getCurrentCustomer();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const provider = read("provider");
    /** Set when the setup started from a contract that should collect from it. */
    const contractId = read("contractId");

    if (provider !== "stripe" && provider !== "paypal") {
        return { status: "error", message: "Unbekannte Zahlungsart." };
    }

    const target = gateway(provider);

    if (!(await target.isEnabled()) || !target.capabilities.storedMethods) {
        return {
            status: "error",
            message: "Diese Zahlungsart steht gerade nicht zur Verfügung.",
        };
    }

    if (contractId) {
        const [contract] = await db
            .select({ id: schema.contract.id })
            .from(schema.contract)
            .where(
                and(
                    eq(schema.contract.id, contractId),
                    eq(schema.contract.customerId, customer.id),
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
            const stripeCustomerId = await ensureStripeCustomer({
                id: customer.id,
                name: customer.company || customer.name,
                email: contact.email,
                stripeCustomerId: customer.stripeCustomerId,
            });

            // Keep the customer id on our side: the next setup and every
            // collection has to reach the same Stripe customer.
            if (customer.stripeCustomerId !== stripeCustomerId) {
                await db
                    .update(schema.customer)
                    .set({ stripeCustomerId, updatedAt: new Date() })
                    .where(eq(schema.customer.id, customer.id));
            }
        }

        const setup = await target.savePaymentMethod({
            id: customer.id,
            name: customer.company || customer.name,
            email: contact.email,
            stripeCustomerId: customer.stripeCustomerId,
        });

        // Written before the customer leaves, so the identifier they come
        // back with means something. Both providers return to a URL anyone
        // could type, carrying an id anyone could present; this row is what
        // makes it this account's.
        await recordSetup(db, {
            id: setup.ref,
            customerId: customer.id,
            provider,
            contractId: contractId || null,
        });

        url = setup.url;
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
 * Withdrawing a stored method. The provider is told first; whether it
 * confirms or not, the local row is revoked and everything that collected
 * from it falls back to manual payment — the row is what we bill from, so a
 * token left behind at the provider is never used again.
 */
export async function removePaymentMethod(
    _previous: PaymentMethodState,
    data: FormData,
): Promise<PaymentMethodState> {
    const { customer } = await getCurrentCustomer();

    const read = (name: string) => String(data.get(name) ?? "").trim();
    const methodId = read("methodId");

    const [method] = await db
        .select()
        .from(schema.paymentMethod)
        .where(
            and(
                eq(schema.paymentMethod.id, methodId),
                eq(schema.paymentMethod.customerId, customer.id),
                isNull(schema.paymentMethod.revokedAt),
            ),
        );

    if (!method) {
        return {
            status: "error",
            message: "Dieses Zahlungsmittel ist nicht mehr hinterlegt.",
        };
    }

    // Fallible, so it runs on its own before the revocation. Whether it
    // worked is remembered rather than assumed: withdrawing the
    // authorisation here always succeeds and is what stops us collecting, but
    // the deletion at the provider is what the customer was promised.
    let detached = true;

    try {
        if (method.provider === "stripe") {
            await detachStoredMethod(method.token);
        } else {
            await deleteVaultToken(method.token);
        }
    } catch (error) {
        console.error("[payment] detaching stored method failed:", error);
        detached = false;
    }

    const revoked = await revokeMethod(db, {
        customerId: customer.id,
        methodId,
        actor: { type: "customer", id: customer.id },
    });

    if (!revoked.ok) {
        return {
            status: "error",
            message:
                "Das Zahlungsmittel konnte nicht entfernt werden. Bitte versuche es erneut.",
        };
    }

    if (detached) {
        await markDetached(db, methodId);
    } else {
        await notifyDetachFailed({
            label: method.label,
            provider: method.provider,
            token: method.token,
        });
    }

    revalidatePath("/client/payment-methods");
    revalidatePath("/client/contracts");

    return {
        status: "removed",
        message: detached
            ? "Das Zahlungsmittel ist entfernt und beim Zahlungsdienstleister gelöscht."
            : "Das Zahlungsmittel ist entfernt und wird nicht mehr verwendet. Die Löschung beim Zahlungsdienstleister konnte gerade nicht bestätigt werden; wir holen sie nach.",
    };
}

/**
 * Which method an automatic collection reaches for. At most one per account,
 * which the database enforces with a partial unique index rather than this
 * action — two tabs are faster than a read followed by a write.
 */
export async function makeDefaultPaymentMethod(
    _previous: PaymentMethodState,
    data: FormData,
): Promise<PaymentMethodState> {
    const { customer } = await getCurrentCustomer();
    const methodId = String(data.get("methodId") ?? "").trim();

    const changed = await setDefaultMethod(db, {
        customerId: customer.id,
        methodId,
        actor: { type: "customer", id: customer.id },
    });

    if (!changed) {
        return {
            status: "error",
            message: "Dieses Zahlungsmittel ist nicht mehr hinterlegt.",
        };
    }

    revalidatePath("/client/payment-methods");

    return { status: "changed", message: "Standard geändert." };
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
    const { operator } = await loadSettings();
    const transport = await mailTransport();

    if (!transport) {
        console.error("[payment] detach failed and no transport:", input);
        return;
    }

    try {
        await transport.sendMail({
            from: await mailFrom(),
            to: operator.email,
            subject: `Zahlungsmittel nicht gelöscht — ${input.provider}`,
            text: [
                `Ein Kunde hat „${input.label}“ entfernt. Der Widerruf ist hier wirksam, aber ${input.provider} hat die Löschung des Tokens nicht bestätigt.`,
                "",
                `Token: ${input.token}`,
                "",
                "Bitte im Konto des Anbieters nachziehen.",
            ].join("\n"),
            html: await renderEmail({
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
    const { customer } = await getCurrentCustomer();

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
                        eq(schema.contract.customerId, customer.id),
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
                        eq(schema.paymentMethod.customerId, customer.id),
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

    revalidatePath("/client/contracts");
    revalidatePath("/client/payment-methods");

    return { status: "changed" };
}

/**
 * Switches automatic collection for one subscription on or off — the Phase 4
 * `auto_charge` opt-in, finally honoured. Phase 6's renewal run reads exactly
 * these two columns.
 */
export async function setSubscriptionCollection(
    _previous: PaymentMethodState,
    data: FormData,
): Promise<PaymentMethodState> {
    const { customer } = await getCurrentCustomer();

    const read = (name: string) => String(data.get(name) ?? "").trim();
    const subscriptionId = read("subscriptionId");
    const methodId = read("methodId");
    const mode = read("mode");

    if (mode !== "on" && mode !== "off") {
        return { status: "error", message: "Unbekannte Aktion." };
    }

    try {
        await db.transaction(async (tx) => {
            const [subscription] = await tx
                .select()
                .from(schema.subscription)
                .where(
                    and(
                        eq(schema.subscription.id, subscriptionId),
                        eq(schema.subscription.customerId, customer.id),
                    ),
                )
                .for("update");

            if (!subscription) {
                throw new Error("not-found");
            }

            if (mode === "off") {
                await tx
                    .update(schema.subscription)
                    .set({
                        autoCharge: false,
                        paymentMethodId: null,
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.subscription.id, subscriptionId));

                return;
            }

            const [method] = await tx
                .select({ id: schema.paymentMethod.id })
                .from(schema.paymentMethod)
                .where(
                    and(
                        eq(schema.paymentMethod.id, methodId),
                        eq(schema.paymentMethod.customerId, customer.id),
                        isNull(schema.paymentMethod.revokedAt),
                    ),
                );

            if (!method) {
                throw new Error("method-unknown");
            }

            await tx
                .update(schema.subscription)
                .set({
                    autoCharge: true,
                    paymentMethodId: method.id,
                    updatedAt: new Date(),
                })
                .where(eq(schema.subscription.id, subscriptionId));
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : "";

        console.error(
            "[payment] changing subscription collection failed:",
            error,
        );

        return {
            status: "error",
            message:
                reason === "method-unknown"
                    ? "Dieses Zahlungsmittel ist nicht mehr hinterlegt."
                    : reason === "not-found"
                      ? "Dieses Abo gibt es nicht."
                      : "Das hat nicht geklappt. Bitte versuche es erneut.",
        };
    }

    revalidatePath("/client/payment-methods");
    revalidatePath("/client/orders");

    return { status: "changed" };
}
