"use client";

import { useActionState } from "react";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { startCreditTopUp, type TopUpState } from "./actions";

const initialState: TopUpState = { status: "idle" };

/** Which gateways are offered is decided on the server. */
export default function TopUpForm({
    gateways,
}: {
    gateways: { id: string; label: string }[];
}) {
    const [state, formAction, pending] = useActionState(
        startCreditTopUp,
        initialState,
    );

    if (gateways.length === 0) {
        return (
            <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                Guthaben lässt sich derzeit nicht aufladen.
            </p>
        );
    }

    return (
        <form action={formAction} className="max-w-md space-y-4">
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="page"
                />
            ) : null}

            <div className="space-y-2">
                <Label htmlFor="topup-amount">Betrag</Label>
                <Input
                    id="topup-amount"
                    name="amount"
                    inputMode="decimal"
                    placeholder="25,00"
                    required
                />
            </div>

            <div className="flex flex-wrap gap-3">
                {gateways.map((one, index) => (
                    <Button
                        key={one.id}
                        type="submit"
                        name="provider"
                        value={one.id}
                        variant={index === 0 ? "default" : "outline"}
                        disabled={pending}
                    >
                        {pending ? "…" : `Mit ${one.label} aufladen`}
                    </Button>
                ))}
            </div>
        </form>
    );
}
