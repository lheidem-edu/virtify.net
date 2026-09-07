"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import ConfirmAction from "@/lib/components/account/confirm-action";
import FormStatus from "@/lib/components/account/form-status";
import {
    acceptOfferForCustomer,
    deleteOffer,
    type OfferState,
    resendOfferMail,
    sendOffer,
    setOfferDecision,
    withdrawOffer,
} from "./actions";

const initialState: OfferState = { status: "idle" };

const checkboxClass =
    "size-4 rounded border accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/** The mail switch both declarations carry: it is off only when the operator
 *  has already said the same thing to the customer by hand. */
function NotifyField({ id, label }: { id: string; label: string }) {
    return (
        <label htmlFor={id} className="flex items-center gap-3 text-sm">
            <input
                id={id}
                type="checkbox"
                name="notify"
                value="yes"
                defaultChecked
                className={checkboxClass}
            />
            {label}
        </label>
    );
}

export function SendOfferAction({ offerId }: { offerId: string }) {
    const [state, formAction, pending] = useActionState(
        sendOffer,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="offerId" value={offerId} />
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
                {pending ? "…" : "Versenden"}
            </Button>
        </form>
    );
}

export function ResendOfferAction({ offerId }: { offerId: string }) {
    const [state, formAction, pending] = useActionState(
        resendOfferMail,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="offerId" value={offerId} />
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            {state.status === "sent" ? (
                <FormStatus
                    tone="success"
                    message="Das Angebot ist erneut versendet."
                    variant="inline"
                />
            ) : null}
            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
            >
                {pending ? "…" : "Erneut senden"}
            </Button>
        </form>
    );
}

/** Declined and expired are records of what happened, so they read as such —
 *  no confirmation, and nothing leaves the house. */
export function RecordDecisionAction({ offerId }: { offerId: string }) {
    const [state, formAction, pending] = useActionState(
        setOfferDecision,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="offerId" value={offerId} />
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            <div className="flex flex-wrap gap-3">
                <Button
                    type="submit"
                    name="decision"
                    value="declined"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                >
                    {pending ? "…" : "Abgelehnt vermerken"}
                </Button>
                <Button
                    type="submit"
                    name="decision"
                    value="expired"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                >
                    {pending ? "…" : "Abgelaufen vermerken"}
                </Button>
            </div>
        </form>
    );
}

export function WithdrawOfferAction({ offerId }: { offerId: string }) {
    return (
        <ConfirmAction
            action={withdrawOffer}
            initialState={initialState}
            fields={{ offerId }}
            label="Zurückziehen"
            title="Angebot zurückziehen?"
            description="Der Kunde kann das Angebot danach nicht mehr annehmen. Es bleibt im Kundenbereich sichtbar und ist als zurückgezogen gekennzeichnet."
            confirmLabel="Zurückziehen"
            variant="outline"
        >
            <NotifyField
                id={`notify-withdraw-${offerId}`}
                label="Kunden per E-Mail informieren"
            />
        </ConfirmAction>
    );
}

export function AcceptForCustomerAction({ offerId }: { offerId: string }) {
    return (
        <ConfirmAction
            action={acceptOfferForCustomer}
            initialState={initialState}
            fields={{ offerId }}
            label="Für den Kunden annehmen"
            title="Angebot für den Kunden annehmen?"
            description="Damit kommt der Vertrag im Namen des Kunden zustande — zu den angebotenen Konditionen und ab sofort. Der Kunde erhält die Auftragsbestätigung per E-Mail."
            confirmLabel="Annehmen"
            variant="outline"
        >
            <NotifyField
                id={`notify-accept-${offerId}`}
                label="Auftragsbestätigung senden"
            />
        </ConfirmAction>
    );
}

export function DeleteOfferAction({
    offerId,
    number,
}: {
    offerId: string;
    number: string;
}) {
    return (
        <ConfirmAction
            action={deleteOffer}
            initialState={initialState}
            fields={{ offerId }}
            label="Löschen"
            title="Entwurf löschen?"
            description={`Der Entwurf und seine Positionen werden entfernt. Die Angebotsnummer ${number} bleibt vergeben und wird nicht erneut verwendet.`}
            confirmLabel="Löschen"
            confirmVariant="destructive"
        />
    );
}
