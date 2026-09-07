/**
 * Legal documents as data rather than markup, so the operator can edit them
 * without touching the code. Two things had to survive that move: the values
 * that must never go stale (the address, the payment term) and the links that
 * must never break (the withdrawal form, the cancellation button). Both stay
 * as placeholders and are resolved when the page renders.
 *
 *   {{operatorEmail}}                    a value from the settings
 *   [Kündigungsschaltfläche](/cancellation)   a link, internal or mailto:
 *
 * A placeholder that names nothing is left standing as written, so a typo is
 * visible on the page rather than silently swallowing a sentence.
 */

/** A list entry, optionally with a nested list of its own. */
export type LegalItem = string | { text: string; items: string[] };

export type LegalVariant =
    /** "(1)", "(2)" — the numbering the paper contracts use. */
    | "paren"
    /** An em-dashed list. */
    | "dash"
    /** Plain paragraphs, one per item. */
    | "prose";

export type LegalSectionData = {
    /** "§ 7", "01" — free text, because the two documents number differently. */
    label?: string;
    title: string;
    variant: LegalVariant;
    items: LegalItem[];
    /**
     * A button below the items. § 21 of the terms has one for the withdrawal
     * form, and § 312k BGB wants its cancellation button to look like one —
     * a link in a sentence would not be the same promise.
     */
    action?: { label: string; href: string };
};

export type LegalDocumentData = {
    title: string;
    eyebrow?: string;
    /** The lead paragraph above the sections. */
    intro?: string;
    sections: LegalSectionData[];
};

export const LEGAL_KINDS = ["terms", "privacy", "imprint"] as const;

export type LegalKind = (typeof LEGAL_KINDS)[number];

export const LEGAL_KIND_LABEL: Record<LegalKind, string> = {
    terms: "AGB",
    privacy: "Datenschutzerklärung",
    imprint: "Impressum",
};

export const LEGAL_KIND_PATH: Record<LegalKind, string> = {
    terms: "/terms",
    privacy: "/privacy",
    imprint: "/legal",
};
