"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type DecisionState, decideOffer } from "./actions";

const initialState: DecisionState = { status: "idle" };

export default function DecideForm({ offerId }: { offerId: string }) {
    const [state, formAction, pending] = useActionState(
        decideOffer,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="offerId" value={offerId} />
            {state.status === "error" ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-5 text-destructive">
                    {state.message}
                </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
                <Button
                    type="submit"
                    name="decision"
                    value="accept"
                    size="sm"
                    disabled={pending}
                >
                    Annehmen
                </Button>
                <Button
                    type="submit"
                    name="decision"
                    value="decline"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                >
                    Ablehnen
                </Button>
            </div>
        </form>
    );
}
