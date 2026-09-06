"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { priceInputValue } from "@/lib/documents/line-items";
import { DEFAULT_UNIT_CODE, UNIT_CODES } from "@/lib/documents/totals";

const selectClass =
    "w-full rounded-lg border bg-transparent px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30";

export type LineItemValue = {
    description: string;
    detail: string | null;
    quantity: number;
    unitCode: string;
    unitPriceCents: number;
};

type Row = { key: number; value?: LineItemValue };

/**
 * The position editor for invoices and offers. Rows are uncontrolled and
 * keyed, so removing one leaves what was typed into the others alone; the
 * server reads the five parallel arrays back through readLineItems.
 */
export default function LineItemFields({ items }: { items?: LineItemValue[] }) {
    const [rows, setRows] = useState<Row[]>(() =>
        items?.length
            ? items.map((value, index) => ({ key: index, value }))
            : [{ key: 0 }],
    );
    const [nextKey, setNextKey] = useState(items?.length || 1);

    return (
        <div className="space-y-4">
            <Label>Positionen</Label>

            {rows.map((row, index) => (
                <div key={row.key} className="space-y-3 rounded-lg border p-4">
                    <div className="grid gap-3 sm:grid-cols-[1fr_5rem_7rem_7rem_auto]">
                        <Input
                            name="itemDescription"
                            placeholder="Bezeichnung"
                            defaultValue={row.value?.description ?? ""}
                            aria-label={`Position ${index + 1}: Bezeichnung`}
                        />
                        <Input
                            name="itemQuantity"
                            type="number"
                            min={1}
                            defaultValue={row.value?.quantity ?? 1}
                            aria-label={`Position ${index + 1}: Menge`}
                        />
                        <select
                            name="itemUnit"
                            defaultValue={
                                row.value?.unitCode ?? DEFAULT_UNIT_CODE
                            }
                            className={selectClass}
                            aria-label={`Position ${index + 1}: Einheit`}
                        >
                            {UNIT_CODES.map((unit) => (
                                <option key={unit.code} value={unit.code}>
                                    {unit.label}
                                </option>
                            ))}
                        </select>
                        <Input
                            name="itemPrice"
                            inputMode="decimal"
                            placeholder="0,00"
                            defaultValue={
                                row.value
                                    ? priceInputValue(row.value.unitPriceCents)
                                    : ""
                            }
                            aria-label={`Position ${index + 1}: Einzelpreis`}
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Position ${index + 1} entfernen`}
                            disabled={rows.length === 1}
                            onClick={() =>
                                setRows(
                                    rows.filter(
                                        (entry) => entry.key !== row.key,
                                    ),
                                )
                            }
                        >
                            <Trash2 />
                        </Button>
                    </div>

                    <Input
                        name="itemDetail"
                        placeholder="Zusatz, etwa Ausstattung oder Vertragsbezug (optional)"
                        defaultValue={row.value?.detail ?? ""}
                        aria-label={`Position ${index + 1}: Zusatz`}
                    />
                </div>
            ))}

            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                    setRows([...rows, { key: nextKey }]);
                    setNextKey(nextKey + 1);
                }}
            >
                <Plus />
                Position hinzufügen
            </Button>

            <p className="text-xs text-muted-foreground">
                Preise ohne Umsatzsteuer (§ 19 UStG). Leere Zeilen werden
                ignoriert.
            </p>
        </div>
    );
}
