"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import {
    type NotificationActionState,
    resendNotification,
    runNotificationsNow,
} from "./actions";

/**
 * „Jetzt senden" — one pass of the same function the worker runs.
 */
export function RunNotificationsButton() {
    const [state, formAction, pending] = useActionState<
        NotificationActionState,
        FormData
    >(runNotificationsNow, { status: "idle" });

    return (
        <form action={formAction} className="flex flex-col items-end gap-2">
            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
            >
                {pending ? "Läuft…" : "Jetzt senden"}
            </Button>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}

/**
 * „Erneut senden" — queues a *new* message.
 *
 * `resendCount` travels in a hidden field and is the precondition of the
 * claim: the server moves the counter only if it is still what this form was
 * rendered with, so a double click queues one message and the second request
 * is told the first one won. The page is revalidated afterwards, which is
 * what gives the button its next valid number.
 */
export function ResendButton({
    id,
    resendCount,
}: {
    id: string;
    resendCount: number;
}) {
    const [state, formAction, pending] = useActionState<
        NotificationActionState,
        FormData
    >(resendNotification, { status: "idle" });

    return (
        <form action={formAction} className="flex flex-col items-end gap-1">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="resendCount" value={resendCount} />
            <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={pending}
                className="h-7 px-2 text-xs"
            >
                {pending ? "…" : "Erneut senden"}
            </Button>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}
