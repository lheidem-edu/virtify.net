export type LineItem = {
    description: string;
    quantity: number;
    unitCode: string;
    unitPriceCents: number;
};

export type Totals = {
    lines: (LineItem & { position: number; lineTotalCents: number })[];
    netCents: number;
    taxCents: number;
    grossCents: number;
};

/**
 * All amounts in cents. Line totals are rounded per line before summing,
 * which is what EN 16931 expects and what keeps the document's own
 * arithmetic consistent with the sum a reader adds up by hand.
 */
export function calculateTotals(items: LineItem[]): Totals {
    const lines = items.map((item, index) => ({
        ...item,
        position: index + 1,
        lineTotalCents: Math.round(item.quantity * item.unitPriceCents),
    }));

    const netCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);

    // § 19 UStG: no VAT is charged, so tax is always zero and the gross
    // equals the net. This is the single place that assumption lives.
    return { lines, netCents, taxCents: 0, grossCents: netCents };
}

/** Unit codes offered in the UI, per UN/ECE Recommendation 20. */
export const UNIT_CODES = [
    { code: "C62", label: "Stück" },
    { code: "MON", label: "Monat" },
    { code: "ANN", label: "Jahr" },
    { code: "HUR", label: "Stunde" },
    { code: "DAY", label: "Tag" },
] as const;
