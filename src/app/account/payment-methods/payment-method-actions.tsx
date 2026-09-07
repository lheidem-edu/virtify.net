"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import ConfirmAction from "@/lib/components/account/confirm-action";
import FormStatus from "@/lib/components/account/form-status";
import SelectField from "@/lib/components/account/select-field";
import {
    type PaymentMethodState,
    removePaymentMethod,
    setContractCollection,
    startPaymentMethodSetup,
} from "./actions";

const initialState: PaymentMethodState = { status: "idle" };

export type StoredMethodOption = { id: string; label: string };

/**
 * Starts the provider's setup page. Which providers are offered is decided on
 * the server — the payment config never reaches the browser.
 */
export function AddPaymentMethod({
    stripe,
    paypal,
    contractId,
}: {
    stripe: boolean;
    paypal: boolean;
    /** Set when the setup came from a contract that should collect from it. */
    contractId?: string;
}) {
    const [state, formAction, pending] = useActionState(
        startPaymentMethodSetup,
        initialState,
    );

    if (!stripe && !paypal) {
        return null;
    }

    return (
        <form action={formAction} className="space-y-3">
            {contractId ? (
                <input type="hidden" name="contractId" value={contractId} />
            ) : null}

            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="page"
                />
            ) : null}

            <div className="flex flex-wrap gap-3">
                {stripe ? (
                    <Button
                        type="submit"
                        name="provider"
                        value="stripe"
                        size="lg"
                        disabled={pending}
                    >
                        {pending ? "…" : "Zahlungsmittel hinterlegen"}
                    </Button>
                ) : null}
                {paypal ? (
                    <Button
                        type="submit"
                        name="provider"
                        value="paypal"
                        variant="outline"
                        size="lg"
                        disabled={pending}
                    >
                        {pending ? "…" : "PayPal hinterlegen"}
                    </Button>
                ) : null}
            </div>
        </form>
    );
}

export function RemovePaymentMethod({
    methodId,
    label,
    provider,
}: {
    methodId: string;
    label: string;
    provider: string;
}) {
    return (
        <ConfirmAction
            action={removePaymentMethod}
            initialState={initialState}
            fields={{ methodId }}
            label="Entfernen"
            title="Zahlungsmittel entfernen?"
            description={
                provider === "stripe"
                    ? `${label} wird nicht mehr verwendet, und wir beauftragen Stripe mit der Löschung — dort ist sie endgültig und lässt sich nicht rückgängig machen. Verträge, die davon eingezogen werden, stellen wir wieder auf manuelle Zahlung um.`
                    : `${label} wird bei PayPal gelöscht. Verträge, die davon eingezogen werden, stellen wir wieder auf manuelle Zahlung um.`
            }
            confirmLabel="Entfernen"
            confirmVariant="destructive"
        />
    );
}

/**
 * The per-contract switch. Without a stored method there is nothing to
 * authorise, so the customer is sent to store one first.
 */
export function ContractCollection({
    contractId,
    methods,
    currentMethodId,
}: {
    contractId: string;
    methods: StoredMethodOption[];
    currentMethodId: string | null;
}) {
    if (currentMethodId) {
        return (
            <ConfirmAction
                action={setContractCollection}
                initialState={initialState}
                fields={{ contractId, mode: "off" }}
                label="Einzug beenden"
                title="Einzug beenden?"
                description="Wir ziehen künftige Rechnungen zu diesem Vertrag nicht mehr ein. Du bezahlst sie dann wieder selbst, innerhalb der Zahlungsfrist auf der Rechnung."
                confirmLabel="Einzug beenden"
                variant="outline"
            />
        );
    }

    if (methods.length === 0) {
        return (
            <Button
                nativeButton={false}
                variant="outline"
                size="sm"
                render={<Link href="/account/payment-methods" />}
            >
                Zahlungsmittel hinterlegen
            </Button>
        );
    }

    return (
        <ConfirmAction
            action={setContractCollection}
            initialState={initialState}
            fields={{ contractId, mode: "on" }}
            label="Einzug einrichten"
            title="Rechnungen automatisch einziehen?"
            description="Du erlaubst uns damit, jede Rechnung zu diesem Vertrag bei Ausstellung von dem gewählten Zahlungsmittel einzuziehen. Du kannst das jederzeit wieder beenden."
            confirmLabel="Einzug einrichten"
            variant="outline"
        >
            <SelectField
                id={`methodId-${contractId}`}
                name="methodId"
                label="Zahlungsmittel"
                required
                options={methods.map((method) => ({
                    value: method.id,
                    label: method.label,
                }))}
            />
        </ConfirmAction>
    );
}
