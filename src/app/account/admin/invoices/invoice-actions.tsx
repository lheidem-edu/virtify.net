"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { type InvoiceState, issueInvoice, setInvoiceState } from "./actions";

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
                <p className="max-w-xs text-xs leading-5 text-destructive">
                    {state.message}
                </p>
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
                {pending ? "…" : "Ausstellen und senden"}
            </Button>
        </form>
    );
}

export function StateForm({
    invoiceId,
    canMarkPaid,
}: {
    invoiceId: string;
    canMarkPaid: boolean;
}) {
    const [, formAction, pending] = useActionState(
        setInvoiceState,
        initialState,
    );

    return (
        <form action={formAction} className="flex gap-2">
            <input type="hidden" name="invoiceId" value={invoiceId} />
            {canMarkPaid ? (
                <Button
                    type="submit"
                    name="action"
                    value="paid"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                >
                    Bezahlt
                </Button>
            ) : null}
            <Button
                type="submit"
                name="action"
                value="cancel"
                variant="ghost"
                size="sm"
                disabled={pending}
            >
                Stornieren
            </Button>
        </form>
    );
}
