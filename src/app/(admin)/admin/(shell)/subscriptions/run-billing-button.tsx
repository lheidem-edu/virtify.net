"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { runNow, type SubscriptionActionState } from "./actions";

/**
 * "Jetzt abrechnen" — the daily pass, on demand.
 *
 * It is a plain button rather than a job on the queue, deliberately: the
 * operator pressing it wants to see what happened, and the run is safe to
 * repeat (see `src/server/billing/run.ts`). The scheduled pass is the
 * worker's business.
 */
export default function RunBillingButton({
    customerId,
}: {
    customerId?: string;
}) {
    const [state, formAction, pending] = useActionState<
        SubscriptionActionState,
        FormData
    >(runNow, { status: "idle" });

    return (
        <form action={formAction} className="flex flex-col items-end gap-2">
            {customerId ? (
                <input type="hidden" name="customerId" value={customerId} />
            ) : null}
            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
            >
                {pending ? "Läuft…" : "Jetzt abrechnen"}
            </Button>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}
