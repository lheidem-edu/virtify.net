import { kleinunternehmer } from "./strategies/kleinunternehmer";
import { regularVat } from "./strategies/regular-vat";
import type { TaxStrategy, TaxStrategyId } from "./types";

/**
 * The strategies this installation knows, and the way to get one by id.
 *
 * Which of them is in force is not decided here — that is `tax_mode_history`
 * and `src/server/tax/mode.ts`, keyed by the date a document is finalized.
 * This module is pure, so the strategies themselves can be unit-tested with
 * nothing running behind them.
 */
export const TAX_STRATEGIES = {
    kleinunternehmer,
    "regular-vat": regularVat,
} as const satisfies Record<TaxStrategyId, TaxStrategy>;

export const TAX_STRATEGY_IDS = Object.keys(TAX_STRATEGIES) as TaxStrategyId[];

/** German names for the admin area. Never shown to a customer. */
export const TAX_STRATEGY_LABEL: Record<TaxStrategyId, string> = {
    kleinunternehmer: "Kleinunternehmer (§ 19 UStG)",
    "regular-vat": "Regelbesteuerung",
};

export const TAX_STRATEGY_DESCRIPTION: Record<TaxStrategyId, string> = {
    kleinunternehmer:
        "Auf keiner Position wird Umsatzsteuer ausgewiesen. Die Rechnung " +
        "trägt stattdessen den Hinweis nach § 19 UStG und zeigt keine " +
        "Steuerspalte.",
    "regular-vat":
        "19 % im Inland, Reverse Charge für EU-Unternehmen mit geprüfter " +
        "USt-IdNr., der Bestimmungslandsatz für EU-Privatkunden über OSS, " +
        "und nicht steuerbar außerhalb der EU.",
};

export function isTaxStrategyId(value: string): value is TaxStrategyId {
    return value in TAX_STRATEGIES;
}

/**
 * The strategy behind an id. Throws rather than falling back: an id that is
 * not known means an invoice was frozen under a strategy this build no longer
 * has, and quietly re-taxing it under another one would rewrite the document.
 */
export function taxStrategy(id: string): TaxStrategy {
    if (!isTaxStrategyId(id)) {
        throw new Error(`Unknown tax strategy: ${id}`);
    }

    return TAX_STRATEGIES[id];
}

export * from "./countries";
export * from "./rates";
export * from "./types";
export { kleinunternehmer, regularVat };
