"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ConfirmAction from "@/lib/components/account/confirm-action";
import FormStatus from "@/lib/components/account/form-status";
import {
    inviteStaff,
    removeStaff,
    resendInvite,
    type StaffState,
} from "./actions";

const initialState: StaffState = { status: "idle" };

export function InviteForm() {
    const [state, formAction, pending] = useActionState(
        inviteStaff,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-xl space-y-6">
            {state.status === "invited" ? (
                <FormStatus tone="success" message={state.message} />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="name">Name</Label>
                    <Input id="name" name="name" autoComplete="off" />
                </div>
                <div className="space-y-3">
                    <Label htmlFor="email">E-Mail-Adresse</Label>
                    <Input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="off"
                    />
                </div>
            </div>

            <Button type="submit" disabled={pending}>
                {pending ? "…" : "Einladen"}
            </Button>
        </form>
    );
}

export function ResendAction({ userId }: { userId: string }) {
    const [state, formAction, pending] = useActionState(
        resendInvite,
        initialState,
    );

    return (
        <form action={formAction} className="flex flex-col items-end gap-1">
            <input type="hidden" name="userId" value={userId} />
            <Button type="submit" variant="ghost" size="sm" disabled={pending}>
                {pending ? "…" : "Einladung erneut senden"}
            </Button>
            {state.status !== "idle" ? (
                <FormStatus
                    tone={state.status === "error" ? "error" : "success"}
                    message={state.message}
                    variant="inline"
                />
            ) : null}
        </form>
    );
}

export function RemoveAction({
    userId,
    email,
}: {
    userId: string;
    email: string;
}) {
    return (
        <ConfirmAction
            action={removeStaff}
            initialState={initialState}
            fields={{ userId }}
            label="Entfernen"
            title="Zugang entfernen?"
            description={`${email} verliert damit sofort den Zugang zur Verwaltung. Das Konto wird gelöscht.`}
            confirmLabel="Entfernen"
            confirmVariant="destructive"
        />
    );
}
