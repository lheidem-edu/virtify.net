import { and, asc, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import FormStatus from "@/components/shared/form-status";
import PageHeader from "@/components/shared/page-header";
import StatusBadge from "@/components/shared/status-badge";
import { db, schema } from "@/db";
import { formatDate, PAYMENT_PROVIDER_LABEL } from "@/lib/format";
import { getCurrentCustomer } from "@/server/customers/current";
import { gateway } from "@/server/payments/gateways";
import { createVaultPaymentToken } from "@/server/payments/gateways/paypal-api";
import { readStoredMethod } from "@/server/payments/gateways/stripe";
import { claimSetup, storeMethod } from "@/server/payments/methods";
import { gatewayConfig } from "@/server/payments/settings";
import {
    AddPaymentMethod,
    MakeDefaultPaymentMethod,
    RemovePaymentMethod,
} from "./payment-method-actions";

type Query = Record<string, string | string[] | undefined>;

/** Providers append their own parameters, so a value can arrive repeated. */
function single(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Both providers return the customer to this page with their own parameters.
 * Returns what to tell the customer, or null when this is an ordinary visit.
 */
async function consumeReturn(customerId: string, query: Query) {
    const sessionId = single(query.session_id);
    const approvalTokenId = single(query.approval_token_id);
    const fromPaypal = single(query.provider) === "paypal" && approvalTokenId;

    if (!sessionId && !fromPaypal) {
        return null;
    }

    // The identifier came out of a URL, so it is worth exactly as much as the
    // row we wrote before sending this account away. Claiming it deletes it:
    // an approval is redeemed once, by the account that asked for it.
    const claimed = await claimSetup(db, {
        id: sessionId ?? approvalTokenId ?? "",
        customerId,
        provider: sessionId ? "stripe" : "paypal",
    });

    if (!claimed) {
        // Either a replayed return, or somebody else's approval — or the
        // Stripe webhook got here first and already stored it. None of those
        // is something to store again, and the customer sees the method on
        // the list below either way.
        return "failed";
    }

    try {
        if (sessionId) {
            // Resolves the checkout session's SetupIntent: the token we may
            // collect from, a label for the customer, and the contract the
            // setup was started from, if any.
            const stored = await readStoredMethod(sessionId);

            // A second lock, from the other side: the SetupIntent carries the
            // account it was created for, so a session that names a different
            // one is not stored whatever the query string claims.
            if (stored?.customerId && stored.customerId !== customerId) {
                throw new Error("setup belongs to another account");
            }

            // Null when the session was never completed — someone reloading
            // an old return URL, or opening one that belongs to nothing.
            if (stored) {
                await storeMethod(db, {
                    customerId,
                    provider: "stripe",
                    token: stored.token,
                    label: stored.label,
                    contractId: claimed.contractId ?? stored.contractId,
                    actor: { type: "customer", id: customerId },
                });
            }
        } else if (approvalTokenId) {
            const stored = await createVaultPaymentToken(approvalTokenId);

            await storeMethod(db, {
                customerId,
                provider: "paypal",
                token: stored.token,
                label: stored.label,
                contractId: claimed.contractId,
                actor: { type: "customer", id: customerId },
            });
        }
    } catch (error) {
        console.error("[payment] storing payment method failed:", error);
        return "failed";
    }

    return "stored";
}

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<Query>;
}) {
    const { customer } = await getCurrentCustomer();
    const query = await searchParams;

    const outcome = await consumeReturn(customer.id, query);

    // The provider's parameters are single-use, so they are swapped for a
    // plain result flag — reloading must not try to redeem an approval twice.
    if (outcome) {
        redirect(`/client/payment-methods?result=${outcome}`);
    }

    const stripe = await gateway("stripe").isEnabled();
    // PayPal only holds a method where reference transactions are approved,
    // which is what the `vault` recurring mode means.
    const paypalConfiguration = await gatewayConfig("paypal");
    const paypal =
        paypalConfiguration.enabled &&
        paypalConfiguration.paypalRecurringMode === "vault";

    const methods = await db
        .select({
            id: schema.paymentMethod.id,
            provider: schema.paymentMethod.provider,
            label: schema.paymentMethod.label,
            isDefault: schema.paymentMethod.isDefault,
            createdAt: schema.paymentMethod.createdAt,
        })
        .from(schema.paymentMethod)
        .where(
            and(
                eq(schema.paymentMethod.customerId, customer.id),
                isNull(schema.paymentMethod.revokedAt),
            ),
        )
        .orderBy(asc(schema.paymentMethod.createdAt));

    const contracts = await db
        .select({
            id: schema.contract.id,
            number: schema.contract.number,
            title: schema.contract.title,
            paymentMethodId: schema.contract.paymentMethodId,
        })
        .from(schema.contract)
        .where(eq(schema.contract.customerId, customer.id));

    const subscriptions = await db
        .select({
            id: schema.subscription.id,
            paymentMethodId: schema.subscription.paymentMethodId,
        })
        .from(schema.subscription)
        .where(eq(schema.subscription.customerId, customer.id));

    const result = single(query.result);

    return (
        <>
            <PageHeader
                title="Zahlungsmittel"
                intro="Hinterlegst du ein Zahlungsmittel, ziehen wir die Rechnungen der Verträge und Abos, für die du den Einzug einrichtest, bei Ausstellung davon ein — und du kannst es jederzeit wieder entfernen."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Hinterlegte Zahlungsmittel
                </h2>

                {result === "stored" ? (
                    <div className="mb-6">
                        <FormStatus
                            tone="success"
                            message="Dein Zahlungsmittel ist hinterlegt."
                        />
                    </div>
                ) : null}
                {result === "failed" ? (
                    <div className="mb-6">
                        <FormStatus
                            tone="error"
                            message="Das Zahlungsmittel konnte nicht hinterlegt werden. Bitte versuche es erneut."
                        />
                    </div>
                ) : null}

                {methods.length === 0 ? (
                    <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                        Du hast noch kein Zahlungsmittel hinterlegt. Deine
                        Rechnungen bezahlst du damit weiterhin selbst.
                    </p>
                ) : (
                    <ul className="max-w-2xl divide-y rounded-lg border">
                        {methods.map((method) => {
                            const usedByContracts = contracts.filter(
                                (entry) => entry.paymentMethodId === method.id,
                            );
                            const usedBySubscriptions = subscriptions.filter(
                                (entry) => entry.paymentMethodId === method.id,
                            ).length;

                            return (
                                <li
                                    key={method.id}
                                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
                                >
                                    <div className="space-y-1">
                                        <p className="flex items-center gap-2 text-sm">
                                            {method.label}
                                            {method.isDefault ? (
                                                <StatusBadge
                                                    label="Standard"
                                                    tone="positive"
                                                />
                                            ) : null}
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            {PAYMENT_PROVIDER_LABEL[
                                                method.provider
                                            ] ?? method.provider}{" "}
                                            · hinterlegt seit{" "}
                                            {formatDate(method.createdAt)}
                                        </p>
                                        <p className="text-muted-foreground text-xs">
                                            {usedByContracts.length === 0 &&
                                            usedBySubscriptions === 0
                                                ? "Wird für nichts eingezogen."
                                                : [
                                                      usedByContracts.length > 0
                                                          ? `Einzug für ${usedByContracts
                                                                .map(
                                                                    (entry) =>
                                                                        entry.title,
                                                                )
                                                                .join(", ")}`
                                                          : null,
                                                      usedBySubscriptions > 0
                                                          ? `${usedBySubscriptions} Abo${usedBySubscriptions === 1 ? "" : "s"}`
                                                          : null,
                                                  ]
                                                      .filter(Boolean)
                                                      .join(" · ")}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-start gap-2">
                                        {method.isDefault ? null : (
                                            <MakeDefaultPaymentMethod
                                                methodId={method.id}
                                            />
                                        )}
                                        <RemovePaymentMethod
                                            methodId={method.id}
                                            label={method.label}
                                            provider={method.provider}
                                        />
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {methods.length > 1 ? (
                    <p className="mt-4 max-w-2xl text-muted-foreground text-xs leading-6">
                        Das Standard-Zahlungsmittel ist das, von dem wir
                        einziehen, wenn für einen Vertrag oder ein Abo nichts
                        anderes hinterlegt ist.
                    </p>
                ) : null}
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 font-medium text-sm tracking-tight">
                    Neues Zahlungsmittel
                </h2>

                {stripe || paypal ? (
                    <div className="max-w-2xl space-y-6">
                        <p className="text-muted-foreground text-sm leading-7">
                            Die Daten gibst du direkt beim Zahlungsdienstleister
                            ein. Bei uns liegt nur ein Verweis darauf, nie deine
                            Karten- oder Kontodaten.
                        </p>
                        <AddPaymentMethod stripe={stripe} paypal={paypal} />
                    </div>
                ) : (
                    <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                        Derzeit lässt sich kein Zahlungsmittel hinterlegen.
                        Deine Rechnungen bezahlst du wie gewohnt per
                        Überweisung.
                    </p>
                )}
            </div>
        </>
    );
}
