"use client";

import { useActionState, useState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CatalogState } from "../actions";
import { CYCLES } from "../labels";
import { addCoupon, removeCoupon, saveCoupon } from "./actions";

const initial: CatalogState = { status: "idle" };

const KINDS = [
    { value: "percent", label: "Prozent" },
    { value: "fixed", label: "Fester Betrag" },
];

const DURATIONS = [
    { value: "once", label: "Einmalig (erster Zeitraum)" },
    { value: "repeating", label: "Für mehrere Zeiträume" },
    { value: "forever", label: "Dauerhaft" },
];

export type CouponFields = {
    id?: string;
    code: string;
    description: string;
    kind: string;
    percent: string;
    amount: string;
    currency: string;
    duration: string;
    durationPeriods: string;
    appliesToSetupFee: boolean;
    productIds: string[];
    cycles: string[];
    validFrom: string;
    validUntil: string;
    maxRedemptions: string;
    active: boolean;
};

export const EMPTY_COUPON: CouponFields = {
    code: "",
    description: "",
    kind: "percent",
    percent: "",
    amount: "",
    currency: "EUR",
    duration: "once",
    durationPeriods: "",
    appliesToSetupFee: false,
    productIds: [],
    cycles: [],
    validFrom: "",
    validUntil: "",
    maxRedemptions: "",
    active: true,
};

export function CouponForm({
    coupon,
    products,
    submitLabel,
}: {
    coupon: CouponFields;
    products: { id: string; name: string }[];
    submitLabel: string;
}) {
    const [state, formAction, pending] = useActionState(
        coupon.id ? saveCoupon : addCoupon,
        initial,
    );
    const prefix = coupon.id ?? "new-coupon";

    return (
        <form action={formAction} className="max-w-3xl space-y-5">
            {coupon.id ? (
                <input type="hidden" name="couponId" value={coupon.id} />
            ) : null}

            {state.status === "saved" ? (
                <FormStatus tone="success" message="Gespeichert." />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-code`}>Code</Label>
                    <Input
                        id={`${prefix}-code`}
                        name="code"
                        defaultValue={coupon.code}
                        required
                        maxLength={40}
                        className="font-mono uppercase"
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-description`}>
                        Interne Notiz
                    </Label>
                    <Input
                        id={`${prefix}-description`}
                        name="description"
                        defaultValue={coupon.description}
                        maxLength={500}
                    />
                </div>

                <SelectField
                    id={`${prefix}-kind`}
                    name="kind"
                    label="Art"
                    options={KINDS}
                    defaultValue={coupon.kind}
                />
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-percent`}>Prozentsatz</Label>
                    <Input
                        id={`${prefix}-percent`}
                        name="percent"
                        defaultValue={coupon.percent}
                        inputMode="decimal"
                        placeholder="25"
                    />
                    <p className="text-xs text-muted-foreground">
                        Nur bei „Prozent“. Nachkommastellen sind erlaubt:
                        „12,5“.
                    </p>
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-amount`}>Betrag</Label>
                    <Input
                        id={`${prefix}-amount`}
                        name="amount"
                        defaultValue={coupon.amount}
                        inputMode="decimal"
                        placeholder="5,00"
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-currency`}>Währung</Label>
                    <Input
                        id={`${prefix}-currency`}
                        name="currency"
                        defaultValue={coupon.currency}
                        maxLength={3}
                    />
                    <p className="text-xs text-muted-foreground">
                        Nur bei „Fester Betrag“.
                    </p>
                </div>

                <SelectField
                    id={`${prefix}-duration`}
                    name="duration"
                    label="Laufzeit"
                    options={DURATIONS}
                    defaultValue={coupon.duration}
                />
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-durationPeriods`}>
                        Anzahl Zeiträume
                    </Label>
                    <Input
                        id={`${prefix}-durationPeriods`}
                        name="durationPeriods"
                        type="number"
                        min={1}
                        max={120}
                        defaultValue={coupon.durationPeriods}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-validFrom`}>Gültig ab</Label>
                    <Input
                        id={`${prefix}-validFrom`}
                        name="validFrom"
                        type="date"
                        defaultValue={coupon.validFrom}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-validUntil`}>Gültig bis</Label>
                    <Input
                        id={`${prefix}-validUntil`}
                        name="validUntil"
                        type="date"
                        defaultValue={coupon.validUntil}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${prefix}-maxRedemptions`}>
                        Höchstzahl Einlösungen
                    </Label>
                    <Input
                        id={`${prefix}-maxRedemptions`}
                        name="maxRedemptions"
                        type="number"
                        min={1}
                        defaultValue={coupon.maxRedemptions}
                        placeholder="unbegrenzt"
                    />
                </div>

                <div className="flex flex-col justify-end gap-3 pb-2 text-sm">
                    <label className="flex items-center gap-3">
                        <input
                            type="checkbox"
                            name="appliesToSetupFee"
                            defaultChecked={coupon.appliesToSetupFee}
                            className="size-4"
                        />
                        Gilt auch für die Einrichtungsgebühr
                    </label>
                    <label className="flex items-center gap-3">
                        <input
                            type="checkbox"
                            name="active"
                            defaultChecked={coupon.active}
                            className="size-4"
                        />
                        Aktiv
                    </label>
                </div>
            </div>

            <fieldset className="space-y-3 rounded-lg border p-5">
                <legend className="px-2 text-xs text-muted-foreground">
                    Abrechnungszeiträume — nichts angekreuzt heißt: alle
                </legend>
                <div className="flex flex-wrap gap-4 text-sm">
                    {CYCLES.map((cycle) => (
                        <label
                            key={cycle.value}
                            className="flex items-center gap-2"
                        >
                            <input
                                type="checkbox"
                                name="cycles"
                                value={cycle.value}
                                defaultChecked={coupon.cycles.includes(
                                    cycle.value,
                                )}
                                className="size-4"
                            />
                            {cycle.label}
                        </label>
                    ))}
                </div>
            </fieldset>

            {products.length > 0 ? (
                <fieldset className="space-y-3 rounded-lg border p-5">
                    <legend className="px-2 text-xs text-muted-foreground">
                        Produkte — nichts angekreuzt heißt: alle
                    </legend>
                    <div className="flex flex-wrap gap-4 text-sm">
                        {products.map((product) => (
                            <label
                                key={product.id}
                                className="flex items-center gap-2"
                            >
                                <input
                                    type="checkbox"
                                    name="productIds"
                                    value={product.id}
                                    defaultChecked={coupon.productIds.includes(
                                        product.id,
                                    )}
                                    className="size-4"
                                />
                                {product.name}
                                <input
                                    type="hidden"
                                    name="knownProductIds"
                                    value={product.id}
                                />
                            </label>
                        ))}
                    </div>
                    {/*
                        What the coupon is restricted to today, so the action
                        can tell an unticked box from a product this form
                        never showed — one past the hundredth, or one that has
                        been deleted. Dropping such a restriction would widen
                        the coupon to the whole catalog.
                    */}
                    {coupon.productIds.map((id) => (
                        <input
                            key={id}
                            type="hidden"
                            name="existingProductIds"
                            value={id}
                        />
                    ))}
                </fieldset>
            ) : null}

            <Button type="submit" disabled={pending}>
                {pending ? "Speichert …" : submitLabel}
            </Button>
        </form>
    );
}

export function NewCoupon({
    products,
}: {
    products: { id: string; name: string }[];
}) {
    const [open, setOpen] = useState(false);

    if (!open) {
        return (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Gutschein anlegen
            </Button>
        );
    }

    return (
        <div className="space-y-5 rounded-lg border p-6">
            <CouponForm
                coupon={EMPTY_COUPON}
                products={products}
                submitLabel="Gutschein anlegen"
            />
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Abbrechen
            </Button>
        </div>
    );
}

export function CouponRowActions({
    coupon,
    products,
}: {
    coupon: CouponFields & { id: string };
    products: { id: string; name: string }[];
}) {
    const [open, setOpen] = useState(false);

    return (
        <>
            <div className="flex items-center justify-end gap-1">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpen((value) => !value)}
                >
                    {open ? "Schließen" : "Bearbeiten"}
                </Button>
                <ConfirmAction
                    action={removeCoupon}
                    initialState={initial}
                    fields={{ couponId: coupon.id }}
                    label="Löschen"
                    title="Gutschein löschen?"
                    description={`„${coupon.code}“ wird entfernt. Ein bereits eingelöster Code lässt sich nur abschalten.`}
                    confirmLabel="Löschen"
                    confirmVariant="destructive"
                />
            </div>

            {open ? (
                <div className="mt-4 rounded-lg border p-6">
                    <CouponForm
                        coupon={coupon}
                        products={products}
                        submitLabel="Speichern"
                    />
                </div>
            ) : null}
        </>
    );
}
