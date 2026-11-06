import { describe, expect, it } from "vitest";
import {
    calculateTotals,
    DEFAULT_UNIT_CODE,
    type LineItem,
} from "@/server/documents/totals";

function line(
    quantity: number,
    unitPriceCents: number,
    description = "KVM-Instanz",
): LineItem {
    return {
        description,
        quantity,
        unitCode: DEFAULT_UNIT_CODE,
        unitPriceCents,
    };
}

describe("calculateTotals", () => {
    it("numbers the lines and sums them", () => {
        const totals = calculateTotals([
            line(1, 1999, "KVM 2"),
            line(12, 499, "Backup"),
        ]);

        expect(totals.lines.map((l) => l.position)).toEqual([1, 2]);
        expect(totals.lines.map((l) => l.lineTotalCents)).toEqual([1999, 5988]);
        expect(totals.netCents).toBe(7987);
    });

    it("charges no VAT, so gross equals net", () => {
        // § 19 UStG. The one place that assumption lives.
        const totals = calculateTotals([line(1, 1999)]);

        expect(totals.taxCents).toBe(0);
        expect(totals.grossCents).toBe(totals.netCents);
    });

    it("rounds a fractional quantity per line", () => {
        // 7.5 months at 19.99 € is 149.925 € → 149.93 €, not 149.92 €.
        expect(calculateTotals([line(7.5, 1999)]).netCents).toBe(14_993);
        // 0.5 × 1 cent rounds away from zero, not to it.
        expect(calculateTotals([line(0.5, 1)]).netCents).toBe(1);
    });

    it("rounds each line before summing, as EN 16931 expects", () => {
        // Three lines of 0.005 € each: 1 + 1 + 1, not round(0.015) = 2.
        const totals = calculateTotals([
            line(0.5, 1),
            line(0.5, 1),
            line(0.5, 1),
        ]);

        expect(totals.lines.map((l) => l.lineTotalCents)).toEqual([1, 1, 1]);
        expect(totals.netCents).toBe(3);
    });

    it("makes a Rechnungskorrektur the exact negation of the invoice", () => {
        const items = [
            line(1, 1999),
            line(12, 499),
            line(7.5, 1999),
            line(0.5, 1),
        ];
        const invoice = calculateTotals(items);
        // A correction negates the quantity, never the price — BR-27 forbids a
        // negative unit price.
        const correction = calculateTotals(
            items.map((item) => ({ ...item, quantity: -item.quantity })),
        );

        expect(correction.netCents).toBe(-invoice.netCents);
        expect(correction.grossCents).toBe(-invoice.grossCents);
        expect(correction.lines.map((l) => l.lineTotalCents)).toEqual(
            invoice.lines.map((l) => -l.lineTotalCents),
        );
    });

    it("totals an empty document to zero rather than throwing", () => {
        const totals = calculateTotals([]);

        expect(totals).toMatchObject({
            lines: [],
            netCents: 0,
            taxCents: 0,
            grossCents: 0,
        });
    });

    it("keeps each line's own fields", () => {
        const [only] = calculateTotals([
            { ...line(1, 1999), detail: "Vertrag V-2026-0001" },
        ]).lines;

        expect(only.description).toBe("KVM-Instanz");
        expect(only.unitCode).toBe("MON");
        expect(only.detail).toBe("Vertrag V-2026-0001");
    });
});
