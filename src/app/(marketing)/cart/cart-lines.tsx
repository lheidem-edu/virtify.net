"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    removeFromCart,
    setCartItemCoupon,
    setCartItemQuantity,
} from "./actions";

/**
 * The cart's lines.
 *
 * Every amount here arrived as a formatted string from the server. There is
 * no arithmetic in this file and there is not meant to be: a total computed
 * in a browser is a second opinion about a price, and the one that disagrees
 * with the invoice is always the one the customer read first.
 */

export type CartLineView = {
    id: string;
    name: string;
    cycleLabel: string;
    quantity: number;
    couponCode: string | null;
    couponError: string | null;
    couponLabel: string | null;
    problem: string | null;
    lines: {
        /** Stable within the item: kind, option, value and recurrence. */
        key: string;
        label: string;
        detail: string | null;
        quantity: number;
        amount: string;
    }[];
    dueToday: string;
    trialDays: number;
};

export default function CartLines({ entries }: { entries: CartLineView[] }) {
    return (
        <ul className="space-y-10">
            {entries.map((entry) => (
                <CartLine key={entry.id} entry={entry} />
            ))}
        </ul>
    );
}

function CartLine({ entry }: { entry: CartLineView }) {
    const [coupon, setCoupon] = useState(entry.couponCode ?? "");
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    function run(action: () => Promise<{ ok: boolean; message?: string }>) {
        setError(null);

        startTransition(async () => {
            const result = await action();

            if (!result.ok) {
                setError(result.message ?? "Das hat nicht geklappt.");
            }
        });
    }

    return (
        <li
            className={`space-y-6 rounded-lg border p-6 ${
                pending ? "opacity-50" : ""
            }`}
        >
            <div className="flex items-baseline justify-between gap-4">
                <div>
                    <h2 className="text-base font-medium tracking-tight">
                        {entry.name}
                    </h2>
                    <p className="text-xs text-zinc-500">{entry.cycleLabel}</p>
                </div>
                <button
                    type="button"
                    className="text-xs text-zinc-500 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    onClick={() => run(() => removeFromCart(entry.id))}
                >
                    Entfernen
                </button>
            </div>

            {entry.problem ? (
                <p className="text-sm text-destructive">{entry.problem}</p>
            ) : (
                <ul className="space-y-3 text-sm">
                    {entry.lines.map((line) => (
                        <li
                            key={line.key}
                            className="flex items-baseline justify-between gap-4"
                        >
                            <span>
                                {line.quantity > 1 ? `${line.quantity} × ` : ""}
                                {line.label}
                                {line.detail ? (
                                    <span className="block text-xs text-zinc-500">
                                        {line.detail}
                                    </span>
                                ) : null}
                            </span>
                            <span className="shrink-0 tabular-nums">
                                {line.amount}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex flex-wrap items-end gap-6 border-t pt-6">
                <div className="w-28 space-y-2">
                    <Label htmlFor={`quantity-${entry.id}`}>Menge</Label>
                    <Input
                        id={`quantity-${entry.id}`}
                        type="number"
                        min={1}
                        max={999}
                        defaultValue={entry.quantity}
                        className="tabular-nums"
                        onBlur={(event) => {
                            const value = Number.parseInt(
                                event.target.value,
                                10,
                            );

                            if (
                                !Number.isFinite(value) ||
                                value === entry.quantity
                            ) {
                                return;
                            }

                            run(() => setCartItemQuantity(entry.id, value));
                        }}
                    />
                </div>

                <div className="w-56 space-y-2">
                    <Label htmlFor={`coupon-${entry.id}`}>Gutscheincode</Label>
                    <div className="flex gap-2">
                        <Input
                            id={`coupon-${entry.id}`}
                            value={coupon}
                            className="font-mono uppercase"
                            onChange={(event) => setCoupon(event.target.value)}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                                run(() =>
                                    setCartItemCoupon(entry.id, coupon.trim()),
                                )
                            }
                        >
                            Einlösen
                        </Button>
                    </div>
                </div>

                <div className="ml-auto text-right">
                    <p className="text-xs text-zinc-500">Heute fällig</p>
                    <p className="tabular-nums">{entry.dueToday}</p>
                </div>
            </div>

            {entry.couponLabel ? (
                <p className="text-xs text-emerald-400">
                    {entry.couponLabel} angerechnet.
                </p>
            ) : null}
            {entry.couponError ? (
                <p className="text-xs text-destructive">{entry.couponError}</p>
            ) : null}
            {entry.trialDays > 0 ? (
                <p className="text-xs text-zinc-500">
                    {entry.trialDays === 1
                        ? "Ein Tag kostenlos"
                        : `${entry.trialDays} Tage kostenlos`}{" "}
                    — die erste laufende Abrechnung folgt danach.
                </p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </li>
    );
}
