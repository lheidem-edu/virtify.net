/**
 * The German labels the catalog's pages and forms share.
 *
 * Deliberately its own module, without `"use client"`: a value exported from
 * a client module and imported by a server component does not arrive as the
 * value. React hands the server a reference to it, so `PRODUCT_TYPES.find`
 * is not a function and the page 500s. Anything both sides read lives here.
 */

export const PRODUCT_TYPES = [
    { value: "vps", label: "VPS" },
    { value: "webhosting", label: "Webhosting" },
    { value: "gameserver", label: "Gameserver" },
    { value: "domain", label: "Domain" },
    { value: "subscription", label: "Abonnement (ohne Bereitstellung)" },
    { value: "other", label: "Sonstiges" },
];

export const PRODUCT_STATUSES = [
    { value: "draft", label: "Entwurf" },
    { value: "active", label: "Aktiv" },
    { value: "hidden", label: "Nur per Link" },
    { value: "retired", label: "Eingestellt" },
];

export const CYCLES = [
    { value: "monthly", label: "Monatlich" },
    { value: "quarterly", label: "Vierteljährlich" },
    { value: "semiannual", label: "Halbjährlich" },
    { value: "annual", label: "Jährlich" },
    { value: "biennial", label: "Zweijährlich" },
    { value: "onetime", label: "Einmalig" },
];

export const OPTION_TYPES = [
    { value: "select", label: "Auswahl (genau ein Wert)" },
    { value: "checkbox", label: "Schalter (an oder aus)" },
    { value: "quantity", label: "Stückzahl (Preis je Einheit)" },
];

/** The label for a value, or the value itself when it is not in the list. */
export function labelFor(
    entries: { value: string; label: string }[],
    value: string,
): string {
    return entries.find((entry) => entry.value === value)?.label ?? value;
}

/** Cents as the operator typed them: `1999` shows as `19,99`. */
export function toInput(cents: number | null | undefined): string {
    return cents === null || cents === undefined
        ? ""
        : (cents / 100).toFixed(2).replace(".", ",");
}
