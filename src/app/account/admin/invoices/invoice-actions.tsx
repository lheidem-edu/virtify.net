"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import ConfirmAction from "@/lib/components/account/confirm-action";
import FormStatus from "@/lib/components/account/form-status";
import {
    cancelInvoice,
    deleteInvoice,
    type InvoiceState,
    issueInvoice,
    markInvoicePaid,
    resendInvoiceMail,
    unmarkInvoicePaid,
} from "./actions";

const initialState: InvoiceState = { status: "idle" };

export function IssueForm({ invoiceId }: { invoiceId: string }) {
    const [state, formAction, pending] = useActionState(
        issueInvoice,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="invoiceId" value={invoiceId} />
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            {state.status === "collected" ? (
                <FormStatus
                    tone="success"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
                {pending ? "…" : "Ausstellen und senden"}
            </Button>
        </form>
    );
}

/** Booking a payment is reversible, so it needs no confirmation. */
export function MarkPaidForm({ invoiceId }: { invoiceId: string }) {
    const [state, formAction, pending] = useActionState(
        markInvoicePaid,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="invoiceId" value={invoiceId} />
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
            >
                {pending ? "…" : "Bezahlt"}
            </Button>
        </form>
    );
}

export function UnmarkPaidForm({ invoiceId }: { invoiceId: string }) {
    const [state, formAction, pending] = useActionState(
        unmarkInvoicePaid,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="invoiceId" value={invoiceId} />
            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="inline"
                />
            ) : null}
            <Button type="submit" variant="ghost" size="sm" disabled={pending}>
                {pending ? "…" : "Zahlung zurücknehmen"}
            </Button>
        </form>
    );
}

export function CancelInvoiceAction({
    invoiceId,
    number,
}: {
    invoiceId: string;
    number: string;
}) {
    return (
        <ConfirmAction
            action={cancelInvoice}
            initialState={initialState}
            fields={{ invoiceId }}
            label="Korrigieren"
            title={`Rechnung ${number} korrigieren?`}
            description="Es entsteht eine Rechnungskorrektur mit eigener Nummer und umgekehrten Vorzeichen, die dem Kunden sofort zugestellt wird. Die ursprüngliche Rechnung bleibt erhalten und gilt als aufgehoben."
            confirmLabel="Korrigieren und senden"
            variant="outline"
            confirmVariant="destructive"
        />
    );
}

export function DeleteInvoiceAction({ invoiceId }: { invoiceId: string }) {
    return (
        <ConfirmAction
            action={deleteInvoice}
            initialState={initialState}
            fields={{ invoiceId }}
            label="Löschen"
            title="Entwurf löschen?"
            description="Der Entwurf und seine Positionen werden entfernt. Eine Nummer wurde noch nicht vergeben, es entsteht also keine Lücke."
            confirmLabel="Löschen"
            confirmVariant="destructive"
        />
    );
}

export function ResendMailAction({
    invoiceId,
    email,
}: {
    invoiceId: string;
    email: string;
}) {
    return (
        <ConfirmAction
            action={resendInvoiceMail}
            initialState={initialState}
            fields={{ invoiceId }}
            label="Erneut senden"
            title="Rechnung erneut senden?"
            description={`Das unveränderte Dokument geht noch einmal an ${email}. Nummer, Datum und Anschrift bleiben, wie sie sind.`}
            confirmLabel="Senden"
            variant="outline"
        />
    );
}
