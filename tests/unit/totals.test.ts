import { describe, expect, it } from "vitest";
import {
    calculateTotals,
    DEFAULT_UNIT_CODE,
    type TaxedLineInput,
} from "@/server/billing/invoices/totals";

/** A § 19 line: 0 %, category E — what every line looks like today. */
function line(
    quantity: number,
    unitPriceCents: number,
    description = "KVM-Instanz",
): TaxedLineInput {
    return {
        description,
        quantity,
        unitCode: DEFAULT_UNIT_CODE,
        unitPriceCents,
        taxRateBp: 0,
        taxCategory: "E",
        taxRule: "kleinunternehmer",
    };
}

/** The same line under regular VAT at 19 %. */
function taxed(
    quantity: number,
    unitPriceCents: number,
    rateBp = 1900,
): TaxedLineInput {
    return {
        ...line(quantity, unitPriceCents),
        taxRateBp: rateBp,
        taxCategory: "S",
        taxRule: "domestic-standard",
    };
}

describe("calculateTotals", () => {
    it("numbers the lines and sums them", () => {
        const totals = calculateTotals([
            line(1, 1999, "KVM 2"),
            line(12, 499, "Backup"),
        ]);

        expect(totals.lines.map((l) => l.position)).toEqual([1, 2]);
        expect(totals.lines.map((l) => l.netCents)).toEqual([1999, 5988]);
        expect(totals.netCents).toBe(7987);
    });

    it("charges no VAT under § 19, so gross equals net", () => {
        const totals = calculateTotals([line(1, 1999)]);

        expect(totals.taxCents).toBe(0);
        expect(totals.grossCents).toBe(totals.netCents);
        expect(totals.groups).toEqual([
            {
                rateBp: 0,
                category: "E",
                rule: "kleinunternehmer",
                netCents: 1999,
                taxCents: 0,
            },
        ]);
    });

    it("puts 19 % on top of the net, not inside it", () => {
        // 19,99 € + 19 % = 23,79 € (3,798 → 3,80 rounded half up).
        const totals = calculateTotals([taxed(1, 1999)]);

        expect(totals.netCents).toBe(1999);
        expect(totals.taxCents).toBe(380);
        expect(totals.grossCents).toBe(2379);
    });

    it("rounds a fractional quantity per line", () => {
        // 7.5 months at 19.99 € is 149.925 € → 149.93 €, not 149.92 €.
        expect(calculateTotals([line(7.5, 1999)]).netCents).toBe(14_993);
        // 0.5 × 1 cent rounds away from zero, not to it.
        expect(calculateTotals([line(0.5, 1)]).netCents).toBe(1);
    });

    it("rounds each line before summing, as EN 16931 BT-131 expects", () => {
        // Three lines of 0.005 € each: 1 + 1 + 1, not round(0.015) = 2.
        const totals = calculateTotals([
            line(0.5, 1),
            line(0.5, 1),
            line(0.5, 1),
        ]);

        expect(totals.lines.map((l) => l.netCents)).toEqual([1, 1, 1]);
        expect(totals.netCents).toBe(3);
    });

    it("computes the tax per rate on the group, not per line", () => {
        // Three lines of 3 cents at 19 %: per line that is 0.57 → 1 cent each,
        // three cents in all. On the group it is 9 × 0.19 = 1.71 → 2 cents.
        // EN 16931 BR-CO-17 and § 14 Abs. 4 Nr. 8 UStG both want the second,
        // which is what the group carries.
        const totals = calculateTotals([taxed(1, 3), taxed(1, 3), taxed(1, 3)]);

        expect(totals.netCents).toBe(9);
        expect(totals.taxCents).toBe(2);
        expect(totals.grossCents).toBe(11);
    });

    it("groups by rate and category, in the order they first appear", () => {
        const totals = calculateTotals([
            taxed(1, 10_000, 1900),
            taxed(1, 5000, 700),
            taxed(2, 10_000, 1900),
        ]);

        expect(totals.groups).toEqual([
            {
                rateBp: 1900,
                category: "S",
                rule: "domestic-standard",
                netCents: 30_000,
                taxCents: 5700,
            },
            {
                rateBp: 700,
                category: "S",
                rule: "domestic-standard",
                netCents: 5000,
                taxCents: 350,
            },
        ]);
        expect(totals.netCents).toBe(35_000);
        expect(totals.taxCents).toBe(6050);
        expect(totals.grossCents).toBe(41_050);
    });

    it("keeps an exempt group apart from a taxed one at the same rate", () => {
        // 0 % reverse charge and 0 % § 19 are different statements, so they
        // are different rows of the tax summary even though both are zero.
        const totals = calculateTotals([
            line(1, 1000),
            {
                ...line(1, 2000),
                taxCategory: "AE",
                taxRule: "eu-b2b-reverse-charge",
            },
        ]);

        expect(totals.groups.map((g) => g.category)).toEqual(["E", "AE"]);
        expect(totals.taxCents).toBe(0);
    });

    it("rounds a half cent of tax away from zero", () => {
        // 50 cents at 19 % is exactly 9.5 → 10, not 9. `basisPoints` divides
        // once on an integer numerator, so the half really is a half.
        expect(calculateTotals([taxed(1, 50)]).taxCents).toBe(10);
        // 7,50 € at 29 % is exactly 217.5 → 2,18 €. The old `cents * rate/100`
        // produced 217.49999999999997 and rounded it down.
        expect(calculateTotals([taxed(1, 750, 2900)]).taxCents).toBe(218);
    });

    it("makes a correction line the exact negation of the line it reverses", () => {
        const items = [
            taxed(1, 1999),
            taxed(12, 499),
            taxed(7.5, 1999),
            taxed(0.5, 1),
        ];
        const invoice = calculateTotals(items);
        const negated = calculateTotals(
            items.map((item) => ({ ...item, quantity: -item.quantity })),
        );

        expect(negated.netCents).toBe(-invoice.netCents);
        expect(negated.taxCents).toBe(-invoice.taxCents);
        expect(negated.grossCents).toBe(-invoice.grossCents);
        expect(negated.lines.map((l) => l.netCents)).toEqual(
            invoice.lines.map((l) => -l.netCents),
        );
    });

    it("lets a partial credit and the remainder add back up to the invoice", () => {
        // 5 × 13,33 € at 19 %. Credit 2 of them; what is left has to be
        // exactly what the invoice charged minus what was credited, net and
        // tax alike — otherwise a partly corrected invoice can never be
        // settled to the cent.
        const invoice = calculateTotals([taxed(5, 1333)]);
        const credited = calculateTotals([taxed(2, 1333)]);
        const remaining = calculateTotals([taxed(3, 1333)]);

        expect(invoice.netCents).toBe(6665);
        expect(credited.netCents).toBe(2666);
        expect(remaining.netCents).toBe(3999);
        expect(credited.netCents + remaining.netCents).toBe(invoice.netCents);

        expect(invoice.taxCents).toBe(1266);
        expect(credited.taxCents).toBe(507);
        expect(remaining.taxCents).toBe(760);
        // One cent apart, and deliberately so: three roundings of a rate
        // cannot be made to agree with one. The invoice's own figure is the
        // one that was charged, and the credit note states what it takes
        // back — which is why the service reads the stored total rather than
        // re-deriving it from what is left.
        expect(credited.taxCents + remaining.taxCents).toBe(
            invoice.taxCents + 1,
        );
    });

    it("totals an empty document to zero rather than throwing", () => {
        const totals = calculateTotals([]);

        expect(totals).toMatchObject({
            lines: [],
            groups: [],
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
        expect(only.taxRule).toBe("kleinunternehmer");
    });
});
