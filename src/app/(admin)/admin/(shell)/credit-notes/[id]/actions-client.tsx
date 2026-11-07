"use client";

import ConfirmAction from "@/components/shared/confirm-action";
import {
    type InvoiceState,
    resendCreditNoteMail,
} from "../../invoices/actions";

const initialState: InvoiceState = { status: "idle" };

export function ResendCreditNoteAction({
    creditNoteId,
    email,
}: {
    creditNoteId: string;
    email: string;
}) {
    return (
        <ConfirmAction
            action={resendCreditNoteMail}
            initialState={initialState}
            fields={{ creditNoteId }}
            label="Erneut senden"
            title="Rechnungskorrektur erneut senden?"
            description={`Das unveränderte Dokument geht noch einmal an ${email || "die hinterlegte Adresse"}. Nummer, Datum und Anschrift bleiben, wie sie sind.`}
            confirmLabel="Senden"
            variant="outline"
        />
    );
}
