"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPrice } from "@/lib/format";
import { type QuoteView, requestQuote } from "./actions";

/**
 * The product page's configurator.
 *
 * It holds the selection and nothing else: every price on the screen comes
 * back from `requestQuote`, which is the same function the checkout and the
 * API use. There is deliberately no arithmetic in this file — a second
 * implementation in the browser is exactly how a shown price starts
 * disagreeing with a charged one.
 */

export type OptionView = {
    id: string;
    name: string;
    description: string | null;
    type: "select" | "checkbox" | "quantity";
    required: boolean;
    minQuantity: number;
    maxQuantity: number;
    values: { id: string; name: string; isDefault: boolean }[];
};

export type ConfiguratorProps = {
    productId: string;
    currency: string;
    cycles: { value: string; label: string }[];
    options: OptionView[];
    maxQuantity: number;
    initial: QuoteView;
};

type Selection = { valueId: string; quantity: number };

function defaults(options: OptionView[]): Record<string, Selection> {
    const chosen: Record<string, Selection> = {};

    for (const option of options) {
        const preferred =
            option.values.find((value) => value.isDefault) ?? option.values[0];

        if (!preferred) {
            continue;
        }

        if (option.type === "select") {
            chosen[option.id] = { valueId: preferred.id, quantity: 1 };
        } else if (option.required) {
            chosen[option.id] = {
                valueId: preferred.id,
                quantity:
                    option.type === "quantity"
                        ? Math.max(1, option.minQuantity)
                        : 1,
            };
        }
    }

    return chosen;
}

export default function Configurator({
    productId,
    currency,
    cycles,
    options,
    maxQuantity,
    initial,
}: ConfiguratorProps) {
    const [cycle, setCycle] = useState(cycles[0]?.value ?? "monthly");
    const [quantity, setQuantity] = useState(1);
    const [selected, setSelected] = useState(() => defaults(options));
    const [couponCode, setCouponCode] = useState("");
    const [submittedCoupon, setSubmittedCoupon] = useState("");
    const [view, setView] = useState<QuoteView>(initial);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        startTransition(async () => {
            setView(
                await requestQuote({
                    productId,
                    cycle,
                    currency,
                    quantity,
                    options: Object.entries(selected).map(
                        ([optionId, entry]) => ({
                            optionId,
                            valueId: entry.valueId,
                            quantity: entry.quantity,
                        }),
                    ),
                    couponCode: submittedCoupon || null,
                }),
            );
        });
    }, [productId, cycle, currency, quantity, selected, submittedCoupon]);

    const quote = view.ok ? view.quote : null;

    return (
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-10">
                {cycles.length > 1 ? (
                    <fieldset className="space-y-4">
                        <legend className="text-sm font-medium tracking-tight">
                            Abrechnung
                        </legend>
                        <div className="flex flex-wrap gap-2">
                            {cycles.map((entry) => (
                                <button
                                    key={entry.value}
                                    type="button"
                                    onClick={() => setCycle(entry.value)}
                                    className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                                        cycle === entry.value
                                            ? "border-ring text-foreground"
                                            : "text-muted-foreground hover:text-foreground"
                                    }`}
                                >
                                    {entry.label}
                                </button>
                            ))}
                        </div>
                    </fieldset>
                ) : null}

                {options.map((option) => (
                    <fieldset key={option.id} className="space-y-4">
                        <legend className="text-sm font-medium tracking-tight">
                            {option.name}
                            {option.required ? " *" : ""}
                        </legend>
                        {option.description ? (
                            <p className="text-sm text-zinc-500">
                                {option.description}
                            </p>
                        ) : null}

                        {option.type === "select" ? (
                            <div className="flex flex-wrap gap-2">
                                {option.values.map((value) => (
                                    <button
                                        key={value.id}
                                        type="button"
                                        onClick={() =>
                                            setSelected((current) => ({
                                                ...current,
                                                [option.id]: {
                                                    valueId: value.id,
                                                    quantity: 1,
                                                },
                                            }))
                                        }
                                        className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                                            selected[option.id]?.valueId ===
                                            value.id
                                                ? "border-ring text-foreground"
                                                : "text-muted-foreground hover:text-foreground"
                                        }`}
                                    >
                                        {value.name}
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {option.type === "checkbox"
                            ? option.values.map((value) => (
                                  <label
                                      key={value.id}
                                      className="flex items-center gap-3 text-sm"
                                  >
                                      <input
                                          type="checkbox"
                                          className="size-4"
                                          checked={
                                              selected[option.id]?.valueId ===
                                              value.id
                                          }
                                          onChange={(event) =>
                                              setSelected((current) => {
                                                  const next = { ...current };

                                                  if (event.target.checked) {
                                                      next[option.id] = {
                                                          valueId: value.id,
                                                          quantity: 1,
                                                      };
                                                  } else {
                                                      delete next[option.id];
                                                  }

                                                  return next;
                                              })
                                          }
                                      />
                                      {value.name}
                                  </label>
                              ))
                            : null}

                        {option.type === "quantity" && option.values[0] ? (
                            <div className="w-32 space-y-2">
                                <Label htmlFor={`option-${option.id}`}>
                                    Anzahl
                                </Label>
                                <Input
                                    id={`option-${option.id}`}
                                    type="number"
                                    min={option.minQuantity}
                                    max={option.maxQuantity}
                                    value={selected[option.id]?.quantity ?? 0}
                                    onChange={(event) => {
                                        const value = Number.parseInt(
                                            event.target.value,
                                            10,
                                        );
                                        const amount = Number.isFinite(value)
                                            ? Math.min(
                                                  Math.max(
                                                      value,
                                                      option.minQuantity,
                                                  ),
                                                  option.maxQuantity,
                                              )
                                            : option.minQuantity;

                                        setSelected((current) => {
                                            const next = { ...current };

                                            if (amount === 0) {
                                                delete next[option.id];
                                            } else {
                                                next[option.id] = {
                                                    valueId:
                                                        option.values[0].id,
                                                    quantity: amount,
                                                };
                                            }

                                            return next;
                                        });
                                    }}
                                    className="tabular-nums"
                                />
                            </div>
                        ) : null}
                    </fieldset>
                ))}

                {maxQuantity > 1 ? (
                    <div className="w-32 space-y-2">
                        <Label htmlFor="product-quantity">Menge</Label>
                        <Input
                            id="product-quantity"
                            type="number"
                            min={1}
                            max={maxQuantity}
                            value={quantity}
                            onChange={(event) => {
                                const value = Number.parseInt(
                                    event.target.value,
                                    10,
                                );

                                setQuantity(
                                    Number.isFinite(value)
                                        ? Math.min(
                                              Math.max(value, 1),
                                              maxQuantity,
                                          )
                                        : 1,
                                );
                            }}
                            className="tabular-nums"
                        />
                    </div>
                ) : null}
            </div>

            <aside className="h-fit space-y-6 rounded-lg border p-6 lg:sticky lg:top-24">
                <h2 className="text-sm font-medium tracking-tight">Preis</h2>

                {!view.ok ? (
                    <p className="text-sm text-destructive">{view.message}</p>
                ) : null}

                {quote ? (
                    <>
                        <ul
                            className={`space-y-3 text-sm ${
                                pending ? "opacity-50" : ""
                            }`}
                        >
                            {quote.lines.map((line, index) => (
                                <li
                                    key={`${line.kind}-${line.value_id ?? index}`}
                                    className="flex items-baseline justify-between gap-4"
                                >
                                    <span>
                                        {line.quantity > 1
                                            ? `${line.quantity} × `
                                            : ""}
                                        {line.label}
                                        {line.detail ? (
                                            <span className="block text-xs text-zinc-500">
                                                {line.detail}
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className="shrink-0 tabular-nums">
                                        {formatPrice(line.amount_cents)}
                                    </span>
                                </li>
                            ))}
                        </ul>

                        <dl className="space-y-3 border-t pt-6 text-sm">
                            <div className="flex items-baseline justify-between gap-4">
                                <dt className="font-medium">Heute fällig</dt>
                                <dd className="tabular-nums">
                                    {formatPrice(quote.totals.due_today_cents)}
                                </dd>
                            </div>
                            {quote.totals.cycle !== "onetime" ? (
                                <div className="flex items-baseline justify-between gap-4 text-zinc-500">
                                    <dt>Danach je Zeitraum</dt>
                                    <dd className="tabular-nums">
                                        {formatPrice(
                                            quote.totals.renewal_cents,
                                        )}
                                    </dd>
                                </div>
                            ) : null}
                            {quote.totals.trial_days > 0 ? (
                                <div className="text-xs text-zinc-500">
                                    {quote.totals.trial_days} Tage kostenlos.
                                    Die erste laufende Abrechnung über{" "}
                                    {formatPrice(
                                        quote.totals.first_period_cents,
                                    )}{" "}
                                    folgt danach.
                                </div>
                            ) : null}
                        </dl>

                        <div className="space-y-3 border-t pt-6">
                            <Label htmlFor="coupon">Gutscheincode</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="coupon"
                                    value={couponCode}
                                    onChange={(event) =>
                                        setCouponCode(event.target.value)
                                    }
                                    className="font-mono uppercase"
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() =>
                                        setSubmittedCoupon(couponCode.trim())
                                    }
                                >
                                    Einlösen
                                </Button>
                            </div>
                            {quote.coupon_error ? (
                                <p className="text-xs text-destructive">
                                    {quote.coupon_error}
                                </p>
                            ) : null}
                            {quote.coupon ? (
                                <p className="text-xs text-emerald-400">
                                    {quote.coupon.code} angerechnet (
                                    {quote.coupon.label}).
                                </p>
                            ) : null}
                        </div>

                        <p className="border-t pt-6 text-xs leading-5 text-zinc-500">
                            Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.
                            Die Bestellung über das Portal folgt in einem
                            späteren Schritt — bis dahin richten wir Instanzen
                            auf Anfrage ein.
                        </p>
                    </>
                ) : null}
            </aside>
        </div>
    );
}
