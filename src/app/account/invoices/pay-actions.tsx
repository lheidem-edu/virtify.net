"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import FormStatus from "@/lib/components/account/form-status";
import { type PayState, startInvoicePayment } from "./actions";

const initialState: PayState = { status: "idle" };

/**
 * One form, one button per configured provider. Which providers exist is
 * decided on the server and passed in as booleans — the payment config is
 * server-only and must not be pulled into the bundle.
 */
export default function PayActions({
    invoiceId,
    stripe,
    paypal,
}: {
    invoiceId: string;
    stripe: boolean;
    paypal: boolean;
}) {
    const [state, formAction, pending] = useActionState(
        startInvoicePayment,
        initialState,
    );

    if (!stripe && !paypal) {
        return null;
    }

    return (
        <form action={formAction} className="flex flex-col items-end gap-2">
            <input type="hidden" name="invoiceId" value={invoiceId} />

            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
                {stripe ? (
                    <Button
                        type="submit"
                        name="provider"
                        value="stripe"
                        size="sm"
                        disabled={pending}
                    >
                        {pending ? "…" : "Mit Karte bezahlen"}
                    </Button>
                ) : null}
                {paypal ? (
                    <Button
                        type="submit"
                        name="provider"
                        value="paypal"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                    >
                        {pending ? "…" : "Mit PayPal bezahlen"}
                    </Button>
                ) : null}
            </div>
        </form>
    );
}
