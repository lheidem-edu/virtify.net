import { EU_COUNTRIES, type EuCountry } from "./countries";

/**
 * The standard VAT rate of each EU member state, with the date it took
 * effect. Only the standard rate is listed: everything this panel sells is an
 * electronically supplied service, and no member state puts those on a
 * reduced rate.
 *
 * The rates live in code rather than in a table on purpose. They are a fact
 * about the world, not a setting of this installation; a table would ship
 * empty, be filled by hand once and then quietly go stale while the invoices
 * it produced looked perfectly ordinary. In code they are versioned, reviewed
 * and covered by tests, and a rate change is a one-line commit with a date on
 * it. (`docs/BUILD_PLAN.md` says "from tax_rates" — this is that, as a module.)
 *
 * Each entry is `[effective from, basis points]`, newest first. A rate is
 * picked by the *finalization date* of the document, so an invoice issued
 * before a change keeps the old rate for ever.
 */
type RateEntry = readonly [from: string, rateBp: number];

const STANDARD_RATES: Record<EuCountry, readonly RateEntry[]> = {
    AT: [["1970-01-01", 2000]],
    BE: [["1970-01-01", 2100]],
    BG: [["1970-01-01", 2000]],
    CY: [["1970-01-01", 1900]],
    CZ: [["1970-01-01", 2100]],
    DE: [["1970-01-01", 1900]],
    DK: [["1970-01-01", 2500]],
    // Raised twice in short order: 20 % → 22 % → 24 %.
    EE: [
        ["2025-07-01", 2400],
        ["2024-01-01", 2200],
        ["1970-01-01", 2000],
    ],
    ES: [["1970-01-01", 2100]],
    // The only member state with a half-point standard rate.
    FI: [
        ["2024-09-01", 2550],
        ["1970-01-01", 2400],
    ],
    FR: [["1970-01-01", 2000]],
    GR: [["1970-01-01", 2400]],
    HR: [["1970-01-01", 2500]],
    HU: [["1970-01-01", 2700]],
    IE: [["1970-01-01", 2300]],
    IT: [["1970-01-01", 2200]],
    LT: [["1970-01-01", 2100]],
    LU: [
        ["2024-01-01", 1700],
        // The 2023 cost-of-living cut, one year only.
        ["2023-01-01", 1600],
        ["1970-01-01", 1700],
    ],
    LV: [["1970-01-01", 2100]],
    MT: [["1970-01-01", 1800]],
    NL: [["1970-01-01", 2100]],
    PL: [["1970-01-01", 2300]],
    PT: [["1970-01-01", 2300]],
    RO: [
        ["2025-08-01", 2100],
        ["1970-01-01", 1900],
    ],
    SE: [["1970-01-01", 2500]],
    SI: [["1970-01-01", 2200]],
    SK: [
        ["2025-01-01", 2300],
        ["1970-01-01", 2000],
    ],
};

/**
 * The standard rate of `country` on `at`, in basis points.
 *
 * The comparison is on the UTC instant of the effective date. A rate change
 * takes effect at midnight local time, and every member state this sells into
 * is within two hours of UTC — a document finalized inside that window would
 * be the only case where the two differ, and the Berlin clock is the one the
 * operator issues by.
 */
export function standardRateBp(country: EuCountry, at: Date): number {
    const entries = STANDARD_RATES[country];
    const time = at.getTime();

    for (const [from, rateBp] of entries) {
        if (Date.parse(`${from}T00:00:00Z`) <= time) {
            return rateBp;
        }
    }

    // Unreachable: every list ends at the epoch. Thrown rather than defaulted,
    // because a silent 0 % would be an invoice that undercharges tax.
    throw new Error(`No VAT rate known for ${country} on ${at.toISOString()}`);
}

/** Every member state and its rate on a date — for the admin area's table. */
export function standardRates(at: Date) {
    return EU_COUNTRIES.map((country) => ({
        country,
        rateBp: standardRateBp(country, at),
    }));
}
