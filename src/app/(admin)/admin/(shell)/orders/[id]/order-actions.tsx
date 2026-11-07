"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { decide, type OrderActionState } from "../actions";

const INITIAL: OrderActionState = { status: "idle" };

/**
 * Accept, cancel, or refuse as fraud.
 *
 * Deliberately three buttons on one form rather than a dropdown: each is a
 * different thing to do to a customer's subscriptions, and marking fraud
 * terminates the services as well. A reason is asked for and stored, because
 * "why was this refused" is the first question anybody asks afterwards.
 */
export default function OrderActions({ orderId }: { orderId: string }) {
    const [state, action, pending] = useActionState(decide, INITIAL);

    return (
        <form action={action} className="space-y-4">
            <input type="hidden" name="orderId" value={orderId} />

            <div className="w-full max-w-sm space-y-2">
                <Label htmlFor="reason">Begründung (intern, optional)</Label>
                <Input id="reason" name="reason" />
            </div>

            <div className="flex flex-wrap gap-3">
                <Button
                    type="submit"
                    name="decision"
                    value="accept"
                    disabled={pending}
                >
                    Annehmen
                </Button>
                <Button
                    type="submit"
                    name="decision"
                    value="cancel"
                    variant="outline"
                    disabled={pending}
                >
                    Stornieren
                </Button>
                <Button
                    type="submit"
                    name="decision"
                    value="fraud"
                    variant="outline"
                    disabled={pending}
                >
                    Als Betrug markieren
                </Button>
            </div>

            {state.status !== "idle" ? (
                <p
                    className={`text-sm ${
                        state.status === "error"
                            ? "text-destructive"
                            : "text-muted-foreground"
                    }`}
                >
                    {state.message}
                </p>
            ) : null}

            <p className="text-xs text-muted-foreground">
                Eine ausgestellte Rechnung wird davon nicht berührt. Sie wird
                ausschließlich über eine Rechnungskorrektur storniert.
            </p>
        </form>
    );
}
