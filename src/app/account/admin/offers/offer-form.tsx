"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import AccountSelect from "@/lib/components/account/account-select";
import LineItemFields from "@/lib/components/account/line-item-fields";
import { createOffer, type OfferState } from "./actions";

const initialState: OfferState = { status: "idle" };

export default function OfferForm({
    accounts,
}: {
    accounts: { id: string; name: string | null; email: string }[];
}) {
    const [state, formAction, pending] = useActionState(
        createOffer,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-6">
            {state.status === "created" ? (
                <p className="rounded-lg border p-4 text-sm text-zinc-300">
                    Entwurf angelegt. Er wird erst mit dem Versenden für den
                    Kunden sichtbar.
                </p>
            ) : null}
            {state.status === "error" ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                    {state.message}
                </p>
            ) : null}

            <AccountSelect accounts={accounts} />

            <div className="space-y-3">
                <Label htmlFor="title">Titel</Label>
                <Input
                    id="title"
                    name="title"
                    placeholder="z. B. KVM-Instanz Basis"
                    required
                />
            </div>

            <div className="space-y-3">
                <Label htmlFor="introText">Einleitungstext</Label>
                <Textarea id="introText" name="introText" rows={3} />
            </div>

            <LineItemFields />

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="monthlyPrice">
                        Monatliche Vergütung des Vertrags
                    </Label>
                    <Input
                        id="monthlyPrice"
                        name="monthlyPrice"
                        inputMode="decimal"
                        placeholder="24,95"
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        Wird bei Annahme in den Vertrag übernommen.
                    </p>
                </div>
                <div className="space-y-3">
                    <Label htmlFor="minimumTermMonths">
                        Grundlaufzeit in Monaten
                    </Label>
                    <Input
                        id="minimumTermMonths"
                        name="minimumTermMonths"
                        type="number"
                        min={0}
                        max={12}
                        defaultValue={12}
                        required
                    />
                </div>
            </div>

            <div className="space-y-3">
                <Label htmlFor="validUntil">Gültig bis</Label>
                <Input id="validUntil" name="validUntil" type="date" />
            </div>

            <div className="space-y-3">
                <Label htmlFor="note">Schlussbemerkung</Label>
                <Textarea id="note" name="note" rows={2} />
            </div>

            <Button
                type="submit"
                size="lg"
                disabled={pending || accounts.length === 0}
            >
                {pending ? "…" : "Entwurf anlegen"}
            </Button>
        </form>
    );
}
