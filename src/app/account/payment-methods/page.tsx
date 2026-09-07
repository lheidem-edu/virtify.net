import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth-session";
import FormStatus from "@/lib/components/account/form-status";
import PageHeader from "@/lib/components/account/page-header";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import { formatDate } from "@/lib/format";
import { paypalConfig, stripeEnabled } from "@/lib/payments/config";
import { createVaultPaymentToken } from "@/lib/payments/paypal";
import { readStoredMethod } from "@/lib/payments/stripe";
import {
    AddPaymentMethod,
    RemovePaymentMethod,
} from "./payment-method-actions";

type Query = Record<string, string | string[] | undefined>;

/** Providers append their own parameters, so a value can arrive repeated. */
function single(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
}

const PROVIDER_LABEL: Record<string, string> = {
    stripe: "Karte",
    paypal: "PayPal",
};

/**
 * Writes the token the customer just approved. The unique token is what makes
 * this safe to repeat: storing the same card twice revives the existing row
 * instead of failing, and a method stored again after removal comes back
 * rather than duplicating.
 */
async function storeMethod(
    userId: string,
    provider: "stripe" | "paypal",
    token: string,
    label: string,
    contractId: string | null,
) {
    await db.transaction(async (tx) => {
        const [row] = await tx
            .insert(schema.paymentMethod)
            .values({
                id: createId("paymentmethod"),
                userId,
                provider,
                token,
                label,
            })
            .onConflictDoUpdate({
                target: schema.paymentMethod.token,
                set: { label, revokedAt: null },
                // Never across accounts: without this, presenting a token that
                // belongs to somebody else would revive their withdrawn
                // authorisation and hand it to whoever asked.
                setWhere: eq(schema.paymentMethod.userId, userId),
            })
            .returning({ id: schema.paymentMethod.id });

        if (!row) {
            throw new Error("token belongs to another account");
        }

        if (!contractId) {
            return;
        }

        // The setup was started from a contract, which is that contract's
        // authorisation — but only for a contract still being invoiced, and
        // only for one of this account's.
        await tx
            .update(schema.contract)
            .set({ paymentMethodId: row.id, updatedAt: new Date() })
            .where(
                and(
                    eq(schema.contract.id, contractId),
                    eq(schema.contract.userId, userId),
                    inArray(schema.contract.status, ["provisioning", "active"]),
                ),
            );
    });
}

/**
 * Both providers return the customer to this page with their own parameters.
 * Returns what to tell the customer, or null when this is an ordinary visit.
 */
async function consumeReturn(userId: string, query: Query) {
    const sessionId = single(query.session_id);
    const approvalTokenId = single(query.approval_token_id);
    const fromPaypal = single(query.provider) === "paypal" && approvalTokenId;

    if (!sessionId && !fromPaypal) {
        return null;
    }

    // The identifier came out of a URL, so it is worth exactly as much as the
    // row we wrote before sending this account away. Claiming it deletes it:
    // an approval is redeemed once, by the account that asked for it.
    const claimed = await db
        .delete(schema.paymentSetup)
        .where(
            and(
                eq(schema.paymentSetup.id, sessionId ?? approvalTokenId ?? ""),
                eq(schema.paymentSetup.userId, userId),
            ),
        )
        .returning({ id: schema.paymentSetup.id });

    if (claimed.length === 0) {
        // Either a replayed return, or somebody else's approval. Neither is
        // something to store, and neither is worth a different message.
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
            if (stored?.userId && stored.userId !== userId) {
                throw new Error("setup belongs to another account");
            }

            // Null when the session was never completed — someone reloading an
            // old return URL, or opening one that belongs to nothing.
            if (stored) {
                await storeMethod(
                    userId,
                    "stripe",
                    stored.token,
                    stored.label,
                    stored.contractId,
                );
            }
        } else if (approvalTokenId) {
            const stored = await createVaultPaymentToken(approvalTokenId);

            await storeMethod(
                userId,
                "paypal",
                stored.token,
                stored.label,
                null,
            );
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
    const session = await requireSession();
    const query = await searchParams;

    const outcome = await consumeReturn(session.user.id, query);

    // The provider's parameters are single-use, so they are swapped for a
    // plain result flag — reloading must not try to redeem an approval twice.
    if (outcome) {
        redirect(`/account/payment-methods?result=${outcome}`);
    }

    const stripe = stripeEnabled();
    // PayPal only holds a method where reference transactions are approved.
    const paypal = paypalConfig.vaulting;

    const methods = await db
        .select({
            id: schema.paymentMethod.id,
            provider: schema.paymentMethod.provider,
            label: schema.paymentMethod.label,
            createdAt: schema.paymentMethod.createdAt,
        })
        .from(schema.paymentMethod)
        .where(
            and(
                eq(schema.paymentMethod.userId, session.user.id),
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
        .where(eq(schema.contract.userId, session.user.id));

    const result = single(query.result);

    return (
        <>
            <PageHeader
                title="Zahlungsmittel"
                intro="Hinterlegst du ein Zahlungsmittel, ziehen wir die Rechnungen der Verträge, für die du den Einzug einrichtest, bei Ausstellung davon ein — und du kannst es jederzeit wieder entfernen."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
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
                    <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
                        Du hast noch kein Zahlungsmittel hinterlegt. Deine
                        Rechnungen bezahlst du damit weiterhin selbst.
                    </p>
                ) : (
                    <ul className="max-w-2xl divide-y rounded-lg border">
                        {methods.map((method) => {
                            const used = contracts.filter(
                                (entry) => entry.paymentMethodId === method.id,
                            );

                            return (
                                <li
                                    key={method.id}
                                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
                                >
                                    <div className="space-y-1">
                                        <p className="text-sm">
                                            {method.label}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {PROVIDER_LABEL[method.provider] ??
                                                method.provider}{" "}
                                            · hinterlegt seit{" "}
                                            {formatDate(method.createdAt)}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {used.length === 0
                                                ? "Wird für keinen Vertrag eingezogen."
                                                : `Einzug für ${used
                                                      .map(
                                                          (entry) =>
                                                              entry.title,
                                                      )
                                                      .join(", ")}.`}
                                        </p>
                                    </div>
                                    <RemovePaymentMethod
                                        methodId={method.id}
                                        label={method.label}
                                        provider={method.provider}
                                    />
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <div className="px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-6 text-sm font-medium tracking-tight">
                    Neues Zahlungsmittel
                </h2>

                {stripe || paypal ? (
                    <div className="max-w-2xl space-y-6">
                        <p className="text-sm leading-7 text-muted-foreground">
                            Die Daten gibst du direkt beim Zahlungsdienstleister
                            ein. Bei uns liegt nur ein Verweis darauf, nie deine
                            Karten- oder Kontodaten.
                        </p>
                        <AddPaymentMethod stripe={stripe} paypal={paypal} />
                    </div>
                ) : (
                    <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
                        Derzeit lässt sich kein Zahlungsmittel hinterlegen.
                        Deine Rechnungen bezahlst du wie gewohnt per
                        Überweisung.
                    </p>
                )}
            </div>
        </>
    );
}
