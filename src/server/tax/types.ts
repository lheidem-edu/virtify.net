/**
 * What a tax strategy is, and what it is allowed to answer.
 *
 * The interface is deliberately small: a strategy decides a rate, a category
 * and the *reason* it decided that way, and it supplies the sentences the
 * document has to carry. It never touches money, never reads the database and
 * never looks at the clock — everything it needs is in the context it is
 * handed, so the same context always produces the same answer. That is what
 * makes a finalized invoice reproducible years later from its own snapshot.
 */

/**
 * UNTDID 5305, the code list EN 16931 (and therefore XRechnung) uses for the
 * VAT category of a line.
 *
 * - `S`  standard rate
 * - `Z`  zero rated
 * - `E`  exempt from tax — what § 19 UStG is
 * - `AE` VAT reverse charge — the recipient owes the tax
 * - `G`  free export item, VAT not charged
 * - `O`  services outside the scope of tax
 */
export type TaxCategory = "S" | "Z" | "E" | "AE" | "G" | "O";

/**
 * Why a line was taxed the way it was. Snapshotted onto the line, so an
 * invoice can still explain itself after the rules, the rates or the
 * strategies have changed.
 */
export type TaxRule =
    /** § 19 UStG: no VAT is charged at all. */
    | "kleinunternehmer"
    /** Supply taxed where the seller is — the ordinary domestic case. */
    | "domestic-standard"
    /** § 3a Abs. 2 UStG: EU business customer with a validated VAT ID. */
    | "eu-b2b-reverse-charge"
    /** One-Stop-Shop: EU consumer, taxed at the destination rate. */
    | "eu-b2c-oss"
    /** Place of supply outside the EU — not taxable in Germany. */
    | "non-eu-out-of-scope";

export type TaxStrategyId = "kleinunternehmer" | "regular-vat";

/** The seller. There is one, and it is the operator of this installation. */
export type TaxSeller = {
    /** ISO 3166-1 alpha-2. */
    country: string;
    /** USt-IdNr., if the operator holds one. */
    vatId: string | null;
    /** Steuernummer — what a Kleinunternehmer prints instead. */
    taxNumber: string | null;
};

export type TaxBuyer = {
    /** ISO 3166-1 alpha-2, or null when the account has no country on file. */
    country: string | null;
    /** Firma or Privatperson. Decides B2B from B2C. */
    kind: "company" | "private";
    vatId: string | null;
    /**
     * When the VAT ID last came back valid from VIES. A number nobody has
     * checked cannot carry a reverse charge: § 18e UStG makes confirming it
     * the seller's job, and getting it wrong makes the seller owe the tax.
     */
    vatIdValidatedAt: Date | null;
};

export type TaxContext = {
    seller: TaxSeller;
    buyer: TaxBuyer;
    /**
     * The moment the document is finalized. The only date that decides tax:
     * a rate that changed afterwards never reaches an invoice already issued,
     * and a rate that changed before it does.
     */
    at: Date;
    /**
     * What is being supplied. Everything this panel sells is a service; the
     * distinction is named rather than assumed so the rule that depends on it
     * is visible when goods are ever added.
     */
    supply: "service" | "goods";
};

export type TaxDetermination = {
    /** Basis points — 1900 is 19 %. Integer, so no float ever touches a rate. */
    rateBp: number;
    category: TaxCategory;
    rule: TaxRule;
};

/**
 * The contract every strategy fulfils. `invoiceNotes` returns the sentences
 * that have to appear on the document — § 14 Abs. 4 Nr. 8 UStG wants a reason
 * printed wherever no tax is shown, and Art. 226 Nr. 11a MwStSystRL wants the
 * words "Steuerschuldnerschaft des Leistungsempfängers" on a reverse charge.
 */
export interface TaxStrategy {
    readonly id: TaxStrategyId;
    determine(context: TaxContext): TaxDetermination;
    invoiceNotes(context: TaxContext): string[];
}

/**
 * Thrown when a strategy cannot decide — an EU sale to an account with no
 * country on file, for instance. Finalizing fails loudly rather than guessing
 * a rate onto a legal document.
 */
export class TaxDeterminationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TaxDeterminationError";
    }
}
