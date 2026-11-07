import type { TaxContext, TaxDetermination, TaxStrategy } from "../types";

/**
 * § 19 UStG — the Kleinunternehmerregelung, and the strategy this
 * installation runs under today.
 *
 * No VAT is charged on anything, to anyone, anywhere: § 19 Abs. 1 Satz 4
 * forbids showing a tax amount at all, and a Kleinunternehmer who prints one
 * owes it under § 14c Abs. 2 UStG whether or not they collected it. So the
 * determination does not look at the buyer, the country or the date — there
 * is nothing for them to change — and the document carries the one sentence
 * § 14 Abs. 4 Nr. 8 UStG asks for in place of a rate.
 *
 * The category is `E` (exempt), not `Z` (zero rated): a zero rate asserts a
 * taxable supply charged at nothing, which is a different statement from a
 * supply that is not taxed, and a validator reading an XRechnung can tell.
 */
export const DETERMINATION: TaxDetermination = {
    rateBp: 0,
    category: "E",
    rule: "kleinunternehmer",
};

/** The exact wording CLAUDE.md fixes. It is quoted on every document. */
export const KLEINUNTERNEHMER_NOTE =
    "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";

export const kleinunternehmer: TaxStrategy = {
    id: "kleinunternehmer",

    determine(_context: TaxContext): TaxDetermination {
        return DETERMINATION;
    },

    invoiceNotes(_context: TaxContext): string[] {
        return [KLEINUNTERNEHMER_NOTE];
    },
};
