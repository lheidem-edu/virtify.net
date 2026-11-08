"use client";

import { useActionState, useState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPrice } from "@/lib/format";
import {
    type ClientSubscriptionState,
    cancelOwn,
    changeOwn,
    resumeOwn,
} from "../actions";

const IDLE: ClientSubscriptionState = { status: "idle" };

export function CancelForm({
    subscriptionId,
    cancelAtPeriodEnd,
    endsAt,
}: {
    subscriptionId: string;
    cancelAtPeriodEnd: boolean;
    endsAt: string | null;
}) {
    if (cancelAtPeriodEnd) {
        return (
            <ConfirmAction
                action={resumeOwn}
                initialState={IDLE}
                fields={{ subscriptionId }}
                label="Kündigung zurücknehmen"
                title="Kündigung zurücknehmen?"
                description="Dein Abo verlängert sich dann wieder wie bisher."
                confirmLabel="Zurücknehmen"
                variant="outline"
            />
        );
    }

    return (
        <ConfirmAction
            action={cancelOwn}
            initialState={IDLE}
            fields={{ subscriptionId }}
            label="Kündigen"
            title="Abo kündigen?"
            description={
                endsAt
                    ? `Die Leistungen laufen bis zum ${endsAt} weiter, danach endet das Abo. Es wird nichts weiter berechnet.`
                    : "Die Leistungen laufen bis zum Ende des bezahlten Zeitraums weiter, danach endet das Abo."
            }
            confirmLabel="Kündigen"
            confirmVariant="destructive"
            variant="outline"
        >
            <Label htmlFor="cancel-reason">
                Magst du uns sagen, warum? (optional)
            </Label>
            <Input id="cancel-reason" name="reason" />
        </ConfirmAction>
    );
}

/**
 * Tarifwechsel with the price first.
 *
 * "Preis anzeigen" and "Wechseln" post the same form; both end in the same
 * function on the server, so the figure here is the figure charged.
 */
export function ChangeForm({
    subscriptionId,
    items,
}: {
    subscriptionId: string;
    items: { id: string; description: string; unitPriceCents: number }[];
}) {
    const [state, formAction, pending] = useActionState<
        ClientSubscriptionState,
        FormData
    >(changeOwn, IDLE);

    /**
     * Controlled on purpose. React resets an uncontrolled form once a
     * `useActionState` action settles, and this form is submitted twice —
     * once for the price, once to book it. Left uncontrolled, "Preis
     * anzeigen" emptied every field and "Wechseln" then booked whatever the
     * defaults happened to be, while the customer was still reading the
     * figure the preview had printed.
     */
    const [itemId, setItemId] = useState(items[0]?.id ?? "");
    const [productId, setProductId] = useState("");
    const [effective, setEffective] = useState<"immediately" | "period_end">(
        "immediately",
    );

    if (items.length === 0) {
        return null;
    }

    return (
        <form action={formAction} className="space-y-4">
            <input type="hidden" name="subscriptionId" value={subscriptionId} />

            <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                    <Label htmlFor="itemId">Position</Label>
                    <select
                        id="itemId"
                        name="itemId"
                        className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                        value={itemId}
                        onChange={(event) => setItemId(event.target.value)}
                    >
                        {items.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.description} (
                                {formatPrice(item.unitPriceCents)})
                            </option>
                        ))}
                    </select>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="productId">Neuer Tarif</Label>
                    <Input
                        id="productId"
                        name="productId"
                        placeholder="z. B. vps-l"
                        value={productId}
                        onChange={(event) => setProductId(event.target.value)}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="effective">Ab wann</Label>
                    <select
                        id="effective"
                        name="effective"
                        className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                        value={effective}
                        onChange={(event) =>
                            setEffective(
                                event.target.value === "period_end"
                                    ? "period_end"
                                    : "immediately",
                            )
                        }
                    >
                        <option value="immediately">
                            sofort, anteilig abgerechnet
                        </option>
                        <option value="period_end">
                            zum Ende des Zeitraums
                        </option>
                    </select>
                </div>
            </div>

            {state.preview ? (
                <div className="rounded-lg border p-4 text-sm">
                    <p>{state.preview.summary}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                        {state.preview.label}
                    </p>
                </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
                <Button
                    type="submit"
                    name="intent"
                    value="preview"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                >
                    Preis anzeigen
                </Button>
                <Button
                    type="submit"
                    name="intent"
                    value="apply"
                    size="sm"
                    disabled={pending}
                >
                    {pending ? "Arbeitet…" : "Wechseln"}
                </Button>
                <FormStatus
                    tone={state.status === "error" ? "error" : "success"}
                    message={state.message}
                    variant="inline"
                />
            </div>
        </form>
    );
}
