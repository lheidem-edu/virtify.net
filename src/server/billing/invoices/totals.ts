import { add, basisPoints, multiply } from "@/lib/money";
import type { TaxCategory } from "@/server/tax/types";

/**
 * The arithmetic of a document. Pure, integer cents, no database, no clock.
 *
 * Two rounding decisions are made here, and they are the ones a reviewer
 * should look at first:
 *
 * 1. **The net of a line is rounded once**, when quantity meets unit price,
 *    and that rounded figure is what everything else adds up. Rounding the
 *    sum of unrounded lines instead would produce a document whose column
 *    does not add up to its own total when a reader checks it by hand, which
 *    is what EN 16931 BT-131 exists to prevent.
 *
 * 2. **The tax is computed per rate, on the sum of the lines at that rate** —
 *    not per line and then added up. § 14 Abs. 4 Nr. 8 UStG asks for "der auf
 *    das Entgelt entfallende Steuerbetrag", singular, per rate, and EN 16931
 *    BR-CO-17 states the same thing: the category tax amount is the category
 *    taxable amount times the rate. Summing per-line roundings can land a
 *    cent away from that and makes a validator reject the invoice. CLAUDE.md
 *    says "rounding half-up per line", which is rule 1; rule 2 is about a
 *    figure that does not exist per line at all.
 *
 * Every rounding goes through `src/lib/money.ts` — half *away from zero*, so
 * a credited line is the exact negation of the line it reverses.
 */

export type TaxedLineInput = {
    description: string;
    /** Small print under the line: contract reference, billing note. */
    detail?: string | null;
    quantity: number;
    /** UN/ECE Recommendation 20 — `MON`, `ANN`, `C62`, … */
    unitCode: string;
    unitPriceCents: number;
    /** Basis points. 1900 is 19 %; 0 is every § 19 line. */
    taxRateBp: number;
    taxCategory: TaxCategory;
    /** Why that rate — the `TaxRule` the strategy returned. */
    taxRule: string;
    servicePeriodStart?: Date | null;
    servicePeriodEnd?: Date | null;
};

export type DocumentLine = TaxedLineInput & {
    position: number;
    netCents: number;
};

/** One row of the tax summary: everything at one rate in one category. */
export type TaxGroup = {
    rateBp: number;
    category: TaxCategory;
    rule: string;
    netCents: number;
    taxCents: number;
};

export type DocumentTotals = {
    lines: DocumentLine[];
    /** In the order the rates first appear, so the summary reads top-down. */
    groups: TaxGroup[];
    netCents: number;
    taxCents: number;
    grossCents: number;
};

export function calculateTotals(items: TaxedLineInput[]): DocumentTotals {
    const lines: DocumentLine[] = items.map((item, index) => ({
        ...item,
        position: index + 1,
        netCents: multiply(item.unitPriceCents, item.quantity),
    }));

    const groups: TaxGroup[] = [];

    for (const line of lines) {
        const existing = groups.find(
            (group) =>
                group.rateBp === line.taxRateBp &&
                group.category === line.taxCategory,
        );

        if (existing) {
            existing.netCents = add(existing.netCents, line.netCents);
        } else {
            groups.push({
                rateBp: line.taxRateBp,
                category: line.taxCategory,
                rule: line.taxRule,
                netCents: line.netCents,
                taxCents: 0,
            });
        }
    }

    for (const group of groups) {
        group.taxCents = basisPoints(group.netCents, group.rateBp);
    }

    const netCents = add(...groups.map((group) => group.netCents));
    const taxCents = add(...groups.map((group) => group.taxCents));

    return {
        lines,
        groups,
        netCents,
        taxCents,
        grossCents: netCents + taxCents,
    };
}

/**
 * The totals of a document whose lines are already stored with their own
 * snapshot. Nothing is re-determined: the rate on the row is the rate that
 * was in force when the document was finalized, and it stays.
 */
export function totalsFromStored(
    items: {
        description: string;
        detail: string | null;
        quantity: number;
        unitCode: string;
        unitPriceCents: number;
        taxRateBp: number | null;
        taxCategory: string | null;
        taxRule: string | null;
        servicePeriodStart?: Date | null;
        servicePeriodEnd?: Date | null;
    }[],
    fallback: { rateBp: number; category: TaxCategory; rule: string },
): DocumentTotals {
    return calculateTotals(
        items.map((item) => ({
            description: item.description,
            detail: item.detail,
            quantity: item.quantity,
            unitCode: item.unitCode,
            unitPriceCents: item.unitPriceCents,
            // A draft has no snapshot yet; it is priced under whatever is in
            // force today, which is exactly what the fallback carries.
            taxRateBp: item.taxRateBp ?? fallback.rateBp,
            taxCategory: (item.taxCategory as TaxCategory) ?? fallback.category,
            taxRule: item.taxRule ?? fallback.rule,
            servicePeriodStart: item.servicePeriodStart ?? null,
            servicePeriodEnd: item.servicePeriodEnd ?? null,
        })),
    );
}

/** Unit codes offered in the UI, per UN/ECE Recommendation 20. */
export const UNIT_CODES = [
    { code: "MON", label: "Monat" },
    { code: "ANN", label: "Jahr" },
    { code: "C62", label: "Stück" },
    { code: "HUR", label: "Stunde" },
    { code: "DAY", label: "Tag" },
] as const;

/** Recurring service is the common case here, so the month leads. */
export const DEFAULT_UNIT_CODE = "MON";
