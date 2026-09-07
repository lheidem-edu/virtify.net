"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import FormStatus from "@/lib/components/account/form-status";
import LineItemFields, {
    type LineItemValue,
} from "@/lib/components/account/line-item-fields";
import SelectField from "@/lib/components/account/select-field";
import { dateInputValue, priceInputValue } from "@/lib/documents/line-items";
import { type OfferState, updateOffer } from "../actions";

const initialState: OfferState = { status: "idle" };

export default function OfferEditForm({
    offerId,
    accounts,
    offer,
    items,
}: {
    offerId: string;
    accounts: { id: string; name: string | null; email: string }[];
    offer: {
        userId: string;
        title: string;
        introText: string | null;
        note: string | null;
        validUntil: Date | null;
        monthlyPriceCents: number;
        minimumTermMonths: number;
    };
    items: LineItemValue[];
}) {
    const [state, formAction, pending] = useActionState(
        updateOffer,
        initialState,
    );

    return (
        <form action={formAction} className="max-w-2xl space-y-6">
            <input type="hidden" name="offerId" value={offerId} />

            {state.status === "updated" ? (
                <FormStatus
                    tone="success"
                    message="Der Entwurf ist gespeichert."
                />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <SelectField
                id="userId"
                label="Konto"
                options={accounts.map((account) => ({
                    value: account.id,
                    label: account.name
                        ? `${account.email} — ${account.name}`
                        : account.email,
                }))}
                defaultValue={offer.userId}
                required
            />

            <div className="space-y-3">
                <Label htmlFor="title">Titel</Label>
                <Input
                    id="title"
                    name="title"
                    defaultValue={offer.title}
                    required
                />
            </div>

            <div className="space-y-3">
                <Label htmlFor="introText">Einleitungstext</Label>
                <Textarea
                    id="introText"
                    name="introText"
                    rows={3}
                    defaultValue={offer.introText ?? ""}
                />
            </div>

            <LineItemFields items={items} />

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-3">
                    <Label htmlFor="monthlyPrice">
                        Monatliche Vergütung des Vertrags
                    </Label>
                    <Input
                        id="monthlyPrice"
                        name="monthlyPrice"
                        inputMode="decimal"
                        defaultValue={priceInputValue(offer.monthlyPriceCents)}
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
                        defaultValue={offer.minimumTermMonths}
                        required
                    />
                    <p className="text-xs text-muted-foreground">
                        Höchstens zwölf Monate (§ 8 (1) AGB).
                    </p>
                </div>
            </div>

            <div className="space-y-3">
                <Label htmlFor="validUntil">Gültig bis</Label>
                <Input
                    id="validUntil"
                    name="validUntil"
                    type="date"
                    defaultValue={dateInputValue(offer.validUntil)}
                />
            </div>

            <div className="space-y-3">
                <Label htmlFor="note">Schlussbemerkung</Label>
                <Textarea
                    id="note"
                    name="note"
                    rows={2}
                    defaultValue={offer.note ?? ""}
                />
            </div>

            <Button type="submit" size="lg" disabled={pending}>
                {pending ? "…" : "Entwurf speichern"}
            </Button>
        </form>
    );
}
