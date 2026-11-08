"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { sweepAction, type TicketActionState } from "./actions";

const INITIAL: TicketActionState = { status: "idle" };

/**
 * "Jetzt abholen" — the same sweep the worker runs every five minutes, run
 * in the request so the operator sees the result instead of watching a
 * queue. Safe to press twice: every message is claimed before it is touched.
 */
export default function SweepButton() {
    const [state, action, pending] = useActionState(sweepAction, INITIAL);

    return (
        <form action={action} className="flex flex-col items-end gap-2">
            <Button type="submit" variant="outline" disabled={pending}>
                {pending ? "Hole ab…" : "Jetzt abholen"}
            </Button>
            <FormStatus
                tone={state.status === "error" ? "error" : "success"}
                message={state.message}
                variant="inline"
            />
        </form>
    );
}
