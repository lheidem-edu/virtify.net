import { DEFAULT_UNIT_CODE, type LineItem } from "@/lib/documents/totals";

/**
 * Line items arrive from the form as parallel arrays. Rows without a
 * description are dropped, so a half-filled spare row does not become an
 * empty line on the document.
 */
export function readLineItems(data: FormData): LineItem[] | null {
    const descriptions = data.getAll("itemDescription").map(String);
    const details = data.getAll("itemDetail").map(String);
    const quantities = data.getAll("itemQuantity").map(String);
    const units = data.getAll("itemUnit").map(String);
    const prices = data.getAll("itemPrice").map(String);

    const items: LineItem[] = [];

    for (let index = 0; index < descriptions.length; index++) {
        const description = descriptions[index]?.trim();

        if (!description) {
            continue;
        }

        const quantity = Number.parseInt(quantities[index] ?? "1", 10);
        const cents = parsePriceToCents(prices[index] ?? "");

        if (!Number.isInteger(quantity) || quantity <= 0 || cents === null) {
            return null;
        }

        items.push({
            description,
            detail: details[index]?.trim() || null,
            quantity,
            unitCode:
                (units[index] ?? DEFAULT_UNIT_CODE).trim() || DEFAULT_UNIT_CODE,
            unitPriceCents: cents,
        });
    }

    return items.length > 0 ? items : null;
}

/**
 * Accepts "9,95" as well as "9.95" — German input is the common case. A
 * leading minus is allowed so an amount can be corrected by hand; callers
 * that must not see one check for it themselves.
 */
export function parsePriceToCents(value: string) {
    const normalised = value.replace(/\s/g, "").replace(",", ".");

    if (!/^-?\d+(\.\d{1,2})?$/.test(normalised)) {
        return null;
    }

    return Math.round(Number(normalised) * 100);
}

/** Like parsePriceToCents, but rejects a negative amount outright. */
export function parsePositivePriceToCents(value: string) {
    const cents = parsePriceToCents(value);
    return cents === null || cents < 0 ? null : cents;
}

export function parseDate(value: string) {
    if (!value) {
        return null;
    }

    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A Date as the `yyyy-mm-dd` an <input type="date"> expects, or "". */
export function dateInputValue(value: Date | null | undefined) {
    return value ? value.toISOString().slice(0, 10) : "";
}

/** Cents as the plain German decimal an amount input expects, or "". */
export function priceInputValue(cents: number | null | undefined) {
    return cents === null || cents === undefined
        ? ""
        : (cents / 100).toFixed(2).replace(".", ",");
}
