"use client";

import { useActionState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    adjustCustomerCredit,
    bookManualPayment,
    type PaymentState,
    refundTransaction,
} from "./actions";

const initialState: PaymentState = { status: "idle" };

export type OpenInvoiceOption = {
    id: string;
    label: string;
    outstandingCents: number;
};

/**
 * Booking money that arrived outside a gateway.
 *
 * `token` is minted on the server when the page renders and is the payment's
 * provider reference, which is unique — so a double-clicked button or a
 * re-posted form books once. It is a hidden field rather than something this
 * component generates, because a value made in the browser is a value the
 * browser can repeat.
 */
export function ManualPaymentForm({
    invoices,
    token,
    fixedInvoiceId,
    today,
}: {
    invoices: OpenInvoiceOption[];
    token: string;
    /** Set on an invoice's own page, where there is nothing to choose. */
    fixedInvoiceId?: string;
    today: string;
}) {
    const [state, formAction, pending] = useActionState(
        bookManualPayment,
        initialState,
    );

    if (!fixedInvoiceId && invoices.length === 0) {
        return (
            <p className="max-w-2xl text-muted-foreground text-sm leading-7">
                Es gibt gerade keine offene Rechnung, auf die sich etwas
                verbuchen ließe.
            </p>
        );
    }

    return (
        <form action={formAction} className="max-w-xl space-y-4">
            <input type="hidden" name="token" value={token} />

            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="page"
                />
            ) : null}
            {state.status === "saved" ? (
                <FormStatus
                    tone="success"
                    message={state.message}
                    variant="page"
                />
            ) : null}

            {fixedInvoiceId ? (
                <input type="hidden" name="invoiceId" value={fixedInvoiceId} />
            ) : (
                <SelectField
                    id="manual-invoice"
                    name="invoiceId"
                    label="Rechnung"
                    required
                    options={invoices.map((invoice) => ({
                        value: invoice.id,
                        label: invoice.label,
                    }))}
                />
            )}

            <SelectField
                id="manual-gateway"
                name="gateway"
                label="Zahlungsweg"
                defaultValue="banktransfer"
                options={[
                    { value: "banktransfer", label: "Überweisung" },
                    { value: "stripe", label: "Kreditkarte (Stripe)" },
                    { value: "paypal", label: "PayPal" },
                ]}
            />

            <div className="space-y-2">
                <Label htmlFor="manual-amount">Betrag</Label>
                <Input
                    id="manual-amount"
                    name="amount"
                    inputMode="decimal"
                    placeholder="29,99"
                    required
                />
                <p className="text-muted-foreground text-xs">
                    Mehr als offen ist, wird dem Konto als Guthaben
                    gutgeschrieben; weniger lässt die Rechnung als teilweise
                    bezahlt stehen.
                </p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="manual-date">Wertstellung</Label>
                <Input
                    id="manual-date"
                    name="bookedAt"
                    type="date"
                    defaultValue={today}
                />
            </div>

            <div className="space-y-2">
                <Label htmlFor="manual-reference">
                    Verwendungszweck oder Referenz
                </Label>
                <Input
                    id="manual-reference"
                    name="reference"
                    placeholder="RE-2026-0012"
                />
            </div>

            <Button type="submit" size="lg" disabled={pending}>
                {pending ? "…" : "Zahlungseingang verbuchen"}
            </Button>
        </form>
    );
}

/**
 * The refund. The dialog spells out what it does to the document, because
 * that is the half an operator cannot undo: a Rechnungskorrektur has its own
 * gapless number and stays for ever.
 */
export function RefundAction({
    paymentId,
    amountCents,
    refundableCents,
    canCreditNote,
}: {
    paymentId: string;
    amountCents: number;
    refundableCents: number;
    canCreditNote: boolean;
}) {
    if (refundableCents <= 0) {
        return null;
    }

    return (
        <ConfirmAction
            action={refundTransaction}
            initialState={initialState}
            fields={{ paymentId }}
            label="Erstatten"
            title="Zahlung erstatten?"
            description={
                canCreditNote
                    ? "Wird der volle noch offene Betrag der Rechnung erstattet, erstellen wir dazu eine Rechnungskorrektur mit eigener Nummer — sie bleibt dauerhaft bestehen. Das Geld geht anschließend über den Zahlungsdienstleister zurück."
                    : "Das Geld geht über den Zahlungsdienstleister zurück. Eine Rechnungskorrektur wird dabei nicht erstellt; die gehört, wenn sie nötig ist, auf die Rechnung selbst."
            }
            confirmLabel="Erstatten"
            confirmVariant="destructive"
            variant="outline"
        >
            <div className="space-y-2">
                <Label htmlFor={`refund-amount-${paymentId}`}>Betrag</Label>
                <Input
                    id={`refund-amount-${paymentId}`}
                    name="amount"
                    inputMode="decimal"
                    defaultValue={(refundableCents / 100)
                        .toFixed(2)
                        .replace(".", ",")}
                    required
                />
                <p className="text-muted-foreground text-xs">
                    Höchstens {(refundableCents / 100).toFixed(2)} € — die
                    Zahlung lautete über {(amountCents / 100).toFixed(2)} €.
                </p>
            </div>

            <div className="space-y-2">
                <Label htmlFor={`refund-reason-${paymentId}`}>Grund</Label>
                <Input
                    id={`refund-reason-${paymentId}`}
                    name="reason"
                    placeholder="Storno der Bestellung"
                    required
                />
            </div>

            <SelectField
                id={`refund-creditnote-${paymentId}`}
                name="creditNote"
                label="Rechnungskorrektur"
                defaultValue={canCreditNote ? "on" : "off"}
                options={[
                    { value: "on", label: "Erstellen" },
                    { value: "off", label: "Nicht erstellen" },
                ]}
            />
        </ConfirmAction>
    );
}

/** Goodwill, or paying a balance back out. */
export function CreditAdjustmentForm({ customerId }: { customerId: string }) {
    const [state, formAction, pending] = useActionState(
        adjustCustomerCredit,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-xl space-y-4">
            <input type="hidden" name="customerId" value={customerId} />

            {state.status === "error" ? (
                <FormStatus
                    tone="error"
                    message={state.message}
                    variant="page"
                />
            ) : null}
            {state.status === "saved" ? (
                <FormStatus
                    tone="success"
                    message={state.message}
                    variant="page"
                />
            ) : null}

            <SelectField
                id={`credit-direction-${customerId}`}
                name="direction"
                label="Richtung"
                defaultValue="credit"
                options={[
                    { value: "credit", label: "Guthaben gutschreiben" },
                    { value: "debit", label: "Guthaben abbuchen" },
                ]}
            />

            <div className="space-y-2">
                <Label htmlFor={`credit-amount-${customerId}`}>Betrag</Label>
                <Input
                    id={`credit-amount-${customerId}`}
                    name="amount"
                    inputMode="decimal"
                    placeholder="10,00"
                    required
                />
            </div>

            <div className="space-y-2">
                <Label htmlFor={`credit-reason-${customerId}`}>Grund</Label>
                <Input
                    id={`credit-reason-${customerId}`}
                    name="reason"
                    placeholder="Kulanz nach Störung"
                    required
                />
            </div>

            <Button type="submit" variant="outline" disabled={pending}>
                {pending ? "…" : "Buchen"}
            </Button>
        </form>
    );
}
