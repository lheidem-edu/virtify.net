/**
 * Which country a line is taxed in, and whether that country is in the EU.
 *
 * Everything here is ISO 3166-1 alpha-2. Accounts created through the panel
 * are validated and upper-cased at the boundary, but older rows carried the
 * country as a word ("Deutschland"), so the normaliser also understands the
 * German and English names of the member states. Anything it cannot place
 * comes back as `null` — which stops a finalization rather than inventing a
 * rate for it.
 */

/** The 27 member states, for § 3a / OSS purposes. */
export const EU_COUNTRIES = [
    "AT",
    "BE",
    "BG",
    "CY",
    "CZ",
    "DE",
    "DK",
    "EE",
    "ES",
    "FI",
    "FR",
    "GR",
    "HR",
    "HU",
    "IE",
    "IT",
    "LT",
    "LU",
    "LV",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SE",
    "SI",
    "SK",
] as const;

export type EuCountry = (typeof EU_COUNTRIES)[number];

const EU = new Set<string>(EU_COUNTRIES);

export function isEuCountry(code: string | null): code is EuCountry {
    return code !== null && EU.has(code);
}

/**
 * Names seen in data that predates the ISO-code validation, plus the handful
 * of codes that differ from the ISO one. `EL` is what VAT IDs and the EU's own
 * lists use for Greece; `UK` is what people type for `GB`.
 */
const ALIASES: Record<string, string> = {
    EL: "GR",
    UK: "GB",

    DEUTSCHLAND: "DE",
    GERMANY: "DE",
    ÖSTERREICH: "AT",
    OESTERREICH: "AT",
    AUSTRIA: "AT",
    SCHWEIZ: "CH",
    SWITZERLAND: "CH",
    FRANKREICH: "FR",
    FRANCE: "FR",
    NIEDERLANDE: "NL",
    NETHERLANDS: "NL",
    BELGIEN: "BE",
    BELGIUM: "BE",
    LUXEMBURG: "LU",
    LUXEMBOURG: "LU",
    ITALIEN: "IT",
    ITALY: "IT",
    SPANIEN: "ES",
    SPAIN: "ES",
    POLEN: "PL",
    POLAND: "PL",
    TSCHECHIEN: "CZ",
    CZECHIA: "CZ",
    DÄNEMARK: "DK",
    DAENEMARK: "DK",
    DENMARK: "DK",
    SCHWEDEN: "SE",
    SWEDEN: "SE",
    FINNLAND: "FI",
    FINLAND: "FI",
    IRLAND: "IE",
    IRELAND: "IE",
    PORTUGAL: "PT",
    GRIECHENLAND: "GR",
    GREECE: "GR",
    UNGARN: "HU",
    HUNGARY: "HU",
    RUMÄNIEN: "RO",
    RUMAENIEN: "RO",
    ROMANIA: "RO",
    BULGARIEN: "BG",
    BULGARIA: "BG",
    KROATIEN: "HR",
    CROATIA: "HR",
    SLOWENIEN: "SI",
    SLOVENIA: "SI",
    SLOWAKEI: "SK",
    SLOVAKIA: "SK",
    LITAUEN: "LT",
    LITHUANIA: "LT",
    LETTLAND: "LV",
    LATVIA: "LV",
    ESTLAND: "EE",
    ESTONIA: "EE",
    MALTA: "MT",
    ZYPERN: "CY",
    CYPRUS: "CY",

    "VEREINIGTE STAATEN": "US",
    "UNITED STATES": "US",
    USA: "US",
    "VEREINIGTES KÖNIGREICH": "GB",
    "UNITED KINGDOM": "GB",
    GROSSBRITANNIEN: "GB",
    NORWEGEN: "NO",
    NORWAY: "NO",
};

/** The alpha-2 code for whatever is on the row, or null if it is not one. */
export function normaliseCountry(value: string | null | undefined) {
    const trimmed = value?.trim();

    if (!trimmed) {
        return null;
    }

    const upper = trimmed.toUpperCase();

    if (ALIASES[upper]) {
        return ALIASES[upper];
    }

    return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

/**
 * German names for the countries a document may be addressed to. DIN 5008
 * wants the country written out, in the language of the sender, and only on
 * a foreign address — `formatRecipient` leaves the home country off
 * entirely, which is why "DE" is absent from this table.
 */
const NAMES: Record<string, string> = {
    AT: "Österreich",
    BE: "Belgien",
    BG: "Bulgarien",
    CH: "Schweiz",
    CY: "Zypern",
    CZ: "Tschechien",
    DK: "Dänemark",
    EE: "Estland",
    ES: "Spanien",
    FI: "Finnland",
    FR: "Frankreich",
    GB: "Vereinigtes Königreich",
    GR: "Griechenland",
    HR: "Kroatien",
    HU: "Ungarn",
    IE: "Irland",
    IT: "Italien",
    LI: "Liechtenstein",
    LT: "Litauen",
    LU: "Luxemburg",
    LV: "Lettland",
    MT: "Malta",
    NL: "Niederlande",
    NO: "Norwegen",
    PL: "Polen",
    PT: "Portugal",
    RO: "Rumänien",
    SE: "Schweden",
    SI: "Slowenien",
    SK: "Slowakei",
    US: "Vereinigte Staaten",
};

/**
 * The country as it belongs on an address block: written out in German where
 * the name is known, and otherwise whatever was stored, because a code the
 * table does not have is still better than nothing on an envelope.
 */
export function countryName(value: string | null | undefined) {
    const code = normaliseCountry(value);

    if (!code) {
        return value?.trim() || null;
    }

    return NAMES[code] ?? code;
}

/**
 * The country part of a VAT ID — `ATU12345678` is Austrian. Only used to
 * cross-check against the account's country, never as a substitute for it:
 * a German company can hold a VAT ID in another member state.
 */
export function vatIdCountry(vatId: string | null | undefined) {
    const code = vatId?.trim().slice(0, 2).toUpperCase();

    if (!code || !/^[A-Z]{2}$/.test(code)) {
        return null;
    }

    return code === "EL" ? "GR" : code;
}
