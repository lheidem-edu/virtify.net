import type { LineItem } from "@/lib/documents/totals";

/**
 * Line items arrive from the form as parallel arrays. Rows without a
 * description are dropped, so a half-filled spare row does not become an
 * empty line on the document.
 */
export function readLineItems(data: FormData): LineItem[] | null {
    const descriptions = data.getAll("itemDescription").map(String);
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
            quantity,
            unitCode: (units[index] ?? "C62").trim() || "C62",
            unitPriceCents: cents,
        });
    }

    return items.length > 0 ? items : null;
}

/** Accepts "9,95" as well as "9.95" — German input is the common case. */
export function parsePriceToCents(value: string) {
    const normalised = value.replace(/\s/g, "").replace(",", ".");

    if (!/^-?\d+(\.\d{1,2})?$/.test(normalised)) {
        return null;
    }

    return Math.round(Number(normalised) * 100);
}

export function parseDate(value: string) {
    if (!value) {
        return null;
    }

    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
