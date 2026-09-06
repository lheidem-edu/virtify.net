"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UNIT_CODES } from "@/lib/documents/totals";

const selectClass =
    "w-full rounded-lg border bg-transparent px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30";

export default function LineItemFields() {
    const [rows, setRows] = useState([0]);
    const [nextKey, setNextKey] = useState(1);

    return (
        <div className="space-y-4">
            <Label>Positionen</Label>

            {rows.map((key, index) => (
                <div
                    key={key}
                    className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_5rem_7rem_7rem_auto]"
                >
                    <Input
                        name="itemDescription"
                        placeholder="Bezeichnung"
                        aria-label={`Position ${index + 1}: Bezeichnung`}
                    />
                    <Input
                        name="itemQuantity"
                        type="number"
                        min={1}
                        defaultValue={1}
                        aria-label={`Position ${index + 1}: Menge`}
                    />
                    <select
                        name="itemUnit"
                        defaultValue="C62"
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
                        aria-label={`Position ${index + 1}: Einzelpreis`}
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Position ${index + 1} entfernen`}
                        disabled={rows.length === 1}
                        onClick={() =>
                            setRows(rows.filter((entry) => entry !== key))
                        }
                    >
                        <Trash2 />
                    </Button>
                </div>
            ))}

            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                    setRows([...rows, nextKey]);
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
