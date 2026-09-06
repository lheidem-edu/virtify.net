"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type OfferState, sendOffer } from "./actions";

const initialState: OfferState = { status: "idle" };

export default function SendForm({ offerId }: { offerId: string }) {
    const [state, formAction, pending] = useActionState(
        sendOffer,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="offerId" value={offerId} />
            {state.status === "error" ? (
                <p className="text-xs leading-5 text-destructive">
                    {state.message}
                </p>
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
                {pending ? "…" : "Versenden"}
            </Button>
        </form>
    );
}
