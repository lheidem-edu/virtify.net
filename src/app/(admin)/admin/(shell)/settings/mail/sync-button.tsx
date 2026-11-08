"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import {
    syncSubscriptionsAction,
    type TicketActionState,
} from "../../tickets/actions";

const INITIAL: TicketActionState = { status: "idle" };

/**
 * Creates or renews the Graph subscriptions now, instead of waiting for the
 * hourly job. Idempotent: it compares what exists against what should exist
 * and does the smallest thing that closes the gap.
 */
export default function SyncButton() {
    const [state, action, pending] = useActionState(
        syncSubscriptionsAction,
        INITIAL,
    );

    return (
        <form action={action} className="flex flex-col items-end gap-2">
            <Button type="submit" variant="outline" disabled={pending}>
                {pending ? "Prüfe…" : "Benachrichtigungen prüfen"}
            </Button>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}
