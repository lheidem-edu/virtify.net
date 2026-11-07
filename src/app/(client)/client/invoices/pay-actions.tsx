"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/format";
import {
    payInvoiceFromCredit,
    type PayState,
    startInvoicePayment,
} from "./actions";

const initialState: PayState = { status: "idle" };

export type GatewayOption = { id: string; label: string };

/**
 * One button per gateway the operator has switched on, plus the balance when
 * there is one to spend.
 *
 * Which gateways exist is decided on the server and passed in as a list of
 * ids and labels — the payment configuration is server-only and must not be
 * pulled into the bundle.
 */
export default function PayActions({
    invoiceId,
    outstandingCents,
    gateways,
    creditCents,
}: {
    invoiceId: string;
    outstandingCents: number;
    gateways: GatewayOption[];
    /** What may be taken from the balance: never more than is owed. */
    creditCents: number;
}) {
    const [state, formAction, pending] = useActionState(
        startInvoicePayment,
        initialState,
    );
    const [creditState, creditAction, creditPending] = useActionState(
        payInvoiceFromCredit,
        initialState,
    );

    if (gateways.length === 0 && creditCents <= 0) {
        return null;
    }

    return (
        <div className="space-y-4">
            {gateways.length > 0 ? (
                <form action={formAction} className="space-y-3">
                    <input type="hidden" name="invoiceId" value={invoiceId} />

                    {state.status === "error" ? (
                        <FormStatus
                            tone="error"
                            message={state.message}
                            variant="inline"
                        />
                    ) : null}

                    <div className="flex flex-wrap gap-3">
                        {gateways.map((one, index) => (
                            <Button
                                key={one.id}
                                type="submit"
                                name="provider"
                                value={one.id}
                                size="lg"
                                variant={index === 0 ? "default" : "outline"}
                                disabled={pending}
                            >
                                {pending
                                    ? "…"
                                    : `${formatPrice(outstandingCents)} mit ${one.label} bezahlen`}
                            </Button>
                        ))}
                    </div>
                </form>
            ) : null}

            {creditCents > 0 ? (
                <form action={creditAction} className="space-y-3">
                    <input type="hidden" name="invoiceId" value={invoiceId} />
                    <input
                        type="hidden"
                        name="amountCents"
                        value={creditCents}
                    />

                    {creditState.status === "error" ? (
                        <FormStatus
                            tone="error"
                            message={creditState.message}
                            variant="inline"
                        />
                    ) : null}

                    <Button
                        type="submit"
                        variant="outline"
                        size="lg"
                        disabled={creditPending}
                    >
                        {creditPending
                            ? "…"
                            : `${formatPrice(creditCents)} aus dem Guthaben verrechnen`}
                    </Button>
                </form>
            ) : null}
        </div>
    );
}
