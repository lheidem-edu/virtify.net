"use client";

import { useActionState, useState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPrice } from "@/lib/format";
import {
    adjust,
    type ChangeActionState,
    cancel,
    change,
    pause,
    resume,
    revokeRenewal,
    type SubscriptionActionState,
    withdrawChange,
} from "../actions";

/**
 * The operator's half of a subscription: cancel, pause, resume, change the
 * tariff, move the billing date, take a renewal back.
 *
 * Everything that cannot be undone by clicking again goes behind
 * `ConfirmAction`, which is what the rest of the admin area does. The
 * Tarifwechsel is the exception and deliberately so: it has a **Vorschau**
 * button first, because the figure is the thing being agreed to.
 */

const IDLE: SubscriptionActionState = { status: "idle" };

export type ItemChoice = {
    id: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
};

export function LifecycleActions({
    subscriptionId,
    status,
    cancelAtPeriodEnd,
}: {
    subscriptionId: string;
    status: string;
    cancelAtPeriodEnd: boolean;
}) {
    const ended = status === "ended";
    const paused = status === "paused";

    return (
        <div className="flex flex-wrap gap-2">
            {!ended && !paused ? (
                <ConfirmAction
                    action={pause}
                    initialState={IDLE}
                    fields={{ subscriptionId }}
                    label="Pausieren"
                    title="Abo pausieren?"
                    description="Es wird nichts mehr berechnet und die Leistungen werden gesperrt. Beim Fortsetzen wandert das Ende des Zeitraums um genau die Spanne nach hinten, die es stillstand."
                    confirmLabel="Pausieren"
                    variant="outline"
                >
                    <Label htmlFor="pause-reason">Grund (optional)</Label>
                    <Input id="pause-reason" name="reason" />
                </ConfirmAction>
            ) : null}

            {paused ? (
                <ConfirmAction
                    action={resume}
                    initialState={IDLE}
                    fields={{ subscriptionId, what: "paused" }}
                    label="Fortsetzen"
                    title="Abo fortsetzen?"
                    description="Die Leistungen werden wieder freigeschaltet und der Zeitraum wird um die Pause verlängert."
                    confirmLabel="Fortsetzen"
                    variant="outline"
                />
            ) : null}

            {cancelAtPeriodEnd && !ended ? (
                <ConfirmAction
                    action={resume}
                    initialState={IDLE}
                    fields={{ subscriptionId, what: "cancellation" }}
                    label="Kündigung zurücknehmen"
                    title="Kündigung zurücknehmen?"
                    description="Das Abo verlängert sich wieder wie bisher."
                    confirmLabel="Zurücknehmen"
                    variant="outline"
                />
            ) : null}

            {!ended && !cancelAtPeriodEnd ? (
                <ConfirmAction
                    action={cancel}
                    initialState={IDLE}
                    fields={{ subscriptionId, when: "period_end" }}
                    label="Zum Ende kündigen"
                    title="Zum Ende des Zeitraums kündigen?"
                    description="Die Leistungen laufen bis zum Ende des bezahlten Zeitraums weiter; es wird keine Verlängerung mehr gestellt. Erstattet wird nichts."
                    confirmLabel="Kündigen"
                    variant="outline"
                >
                    <Label htmlFor="cancel-reason">Grund (optional)</Label>
                    <Input id="cancel-reason" name="reason" />
                </ConfirmAction>
            ) : null}

            {!ended ? (
                <ConfirmAction
                    action={cancel}
                    initialState={IDLE}
                    fields={{ subscriptionId, when: "now" }}
                    label="Sofort beenden"
                    title="Abo sofort beenden?"
                    description="Das Abo endet heute und die Leistungen werden abgebaut. Das lässt sich nicht rückgängig machen. Erstattet wird nichts — ob Geld zurückgeht, entscheidest du gesondert."
                    confirmLabel="Beenden"
                    confirmVariant="destructive"
                    variant="outline"
                >
                    <Label htmlFor="end-reason">Grund (optional)</Label>
                    <Input id="end-reason" name="reason" />
                </ConfirmAction>
            ) : null}
        </div>
    );
}

/** Billing date, automatic collection and the price of each position. */
export function AdjustForm({
    subscriptionId,
    nextBillingAt,
    autoCharge,
    items,
}: {
    subscriptionId: string;
    nextBillingAt: string | null;
    autoCharge: boolean;
    items: ItemChoice[];
}) {
    const [state, formAction, pending] = useActionState<
        SubscriptionActionState,
        FormData
    >(adjust, IDLE);

    return (
        <form action={formAction} className="space-y-4">
            <input type="hidden" name="subscriptionId" value={subscriptionId} />

            <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor="nextBillingAt">Nächste Abrechnung</Label>
                    <Input
                        id="nextBillingAt"
                        name="nextBillingAt"
                        type="date"
                        defaultValue={nextBillingAt ?? ""}
                    />
                    <p className="text-xs text-muted-foreground">
                        Der Tag, an dem die nächste Rechnung fällig wird. Die
                        Rechnung selbst geht einige Tage vorher raus.
                    </p>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="autoCharge">Automatischer Einzug</Label>
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            id="autoCharge"
                            type="checkbox"
                            name="autoCharge"
                            defaultChecked={autoCharge}
                            className="size-4"
                        />
                        Verlängerungen vom hinterlegten Zahlungsmittel einziehen
                    </label>
                </div>
            </div>

            {items.length > 0 ? (
                <div className="space-y-3">
                    {items.map((item) => (
                        <div key={item.id} className="space-y-2">
                            <Label htmlFor={`price-${item.id}`}>
                                {item.description} — Grundpreis je Einheit und
                                Zeitraum
                            </Label>
                            <Input
                                id={`price-${item.id}`}
                                name={`price:${item.id}`}
                                inputMode="decimal"
                                defaultValue={(
                                    item.unitPriceCents / 100
                                ).toFixed(2)}
                            />
                        </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                        Ein Preis, der hier geändert wird, gilt ab der nächsten
                        Verlängerung. Soll der Kunde den Betrag vorher sehen und
                        bestätigen, nimm den Tarifwechsel.
                    </p>
                </div>
            ) : null}

            <div className="flex items-center gap-3">
                <Button type="submit" size="sm" disabled={pending}>
                    {pending ? "Speichert…" : "Speichern"}
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

/**
 * The Tarifwechsel, with its preview.
 *
 * "Vorschau" and "Wechseln" post the same form to the same action; the only
 * difference is the `intent`, and both end in `previewChange()`. The number
 * the operator reads is therefore the number that gets booked.
 */
export function ChangeForm({
    subscriptionId,
    items,
}: {
    subscriptionId: string;
    items: ItemChoice[];
}) {
    const [state, formAction, pending] = useActionState<
        ChangeActionState,
        FormData
    >(change, { status: "idle" });

    /**
     * Controlled, and that is load-bearing rather than taste.
     *
     * React resets an uncontrolled form after a `useActionState` action
     * settles. This form is submitted **twice** — once for the Vorschau and
     * once to book it — so with uncontrolled inputs the preview wiped every
     * field, the select snapped back to the first position, and "Wechseln"
     * then booked the wrong line at the old price while the operator was
     * still reading the figure the preview had printed. Found by driving the
     * real page, not by a test.
     */
    const [itemId, setItemId] = useState(items[0]?.id ?? "");
    const [productId, setProductId] = useState("");
    const [quantity, setQuantity] = useState("");
    const [effective, setEffective] = useState<"immediately" | "period_end">(
        "immediately",
    );

    if (items.length === 0) {
        return null;
    }

    return (
        <form action={formAction} className="space-y-4">
            <input type="hidden" name="subscriptionId" value={subscriptionId} />

            <div className="grid gap-4 md:grid-cols-2">
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
                                {item.description} ({item.quantity} ×{" "}
                                {formatPrice(item.unitPriceCents)})
                            </option>
                        ))}
                    </select>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="productId">
                        Neues Produkt (ID oder Slug)
                    </Label>
                    <Input
                        id="productId"
                        name="productId"
                        placeholder="leer lassen = Produkt bleibt"
                        value={productId}
                        onChange={(event) => setProductId(event.target.value)}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="quantity">Neue Menge</Label>
                    <Input
                        id="quantity"
                        name="quantity"
                        inputMode="numeric"
                        placeholder="leer lassen = Menge bleibt"
                        value={quantity}
                        onChange={(event) => setQuantity(event.target.value)}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="effective">Wirksam</Label>
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
                        {state.preview.invoiceTodayCents > 0
                            ? ` · heute ${formatPrice(state.preview.invoiceTodayCents)} in Rechnung`
                            : state.preview.creditTodayCents > 0
                              ? ` · heute ${formatPrice(state.preview.creditTodayCents)} als Guthaben`
                              : ""}
                    </p>
                </div>
            ) : null}

            <div className="flex items-center gap-3">
                <Button
                    type="submit"
                    name="intent"
                    value="preview"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                >
                    Vorschau
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

export function WithdrawChangeButton({
    subscriptionId,
    changeId,
    description,
}: {
    subscriptionId: string;
    changeId: string;
    description: string;
}) {
    return (
        <ConfirmAction
            action={withdrawChange}
            initialState={IDLE}
            fields={{ subscriptionId, changeId }}
            label="Zurücknehmen"
            title="Vorgemerkten Wechsel zurücknehmen?"
            description={`Der Wechsel auf „${description}“ findet dann nicht statt.`}
            confirmLabel="Zurücknehmen"
        />
    );
}

/**
 * Takes a renewal back: a Rechnungskorrektur over the whole invoice, the
 * coupon period given back and the billing period rolled to where it was.
 * The next run then raises a correct one.
 */
export function RevokeRenewalButton({
    subscriptionId,
    invoiceId,
    number,
}: {
    subscriptionId: string;
    invoiceId: string;
    number: string | null;
}) {
    return (
        <ConfirmAction
            action={revokeRenewal}
            initialState={IDLE}
            fields={{ subscriptionId, invoiceId }}
            label="Verlängerung zurücknehmen"
            title="Verlängerung zurücknehmen?"
            description={`Zu ${number ?? "dieser Rechnung"} wird eine Rechnungskorrektur über den vollen Betrag ausgestellt, der Abrechnungszeitraum wird zurückgesetzt und ein etwaiger Gutschein-Zeitraum zurückgegeben. Der nächste Lauf stellt dann eine neue Rechnung.`}
            confirmLabel="Zurücknehmen"
            confirmVariant="destructive"
        >
            <Label htmlFor="revoke-reason">Grund (optional)</Label>
            <Input id="revoke-reason" name="reason" />
        </ConfirmAction>
    );
}
