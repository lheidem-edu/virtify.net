import { isEuCountry, normaliseCountry } from "../countries";
import { standardRateBp } from "../rates";
import {
    type TaxContext,
    type TaxDetermination,
    TaxDeterminationError,
    type TaxStrategy,
} from "../types";

/**
 * Regular VAT. Implemented, tested and **not active** — it is what this
 * installation switches to when § 19 UStG stops applying, and it is written
 * now so that the switch is a date in `tax_mode_history` rather than a
 * rewrite of the invoicing engine under time pressure.
 *
 * Four cases, in the order they are decided:
 *
 * 1. **Domestic.** Buyer in the seller's country → the standard rate there,
 *    category `S`. A German VAT ID changes nothing: hosting is not one of the
 *    § 13b supplies that reverse-charge inside Germany.
 * 2. **EU B2B with a validated VAT ID.** § 3a Abs. 2 UStG puts the place of
 *    supply where the recipient is, and Art. 196 MwStSystRL makes them the
 *    one who owes the tax. 0 %, category `AE`, and the invoice has to say so.
 *    The ID must have come back valid from VIES — an unchecked number is
 *    treated as no number at all, because under § 18e UStG the seller is the
 *    one who owes the tax when it turns out to be wrong.
 * 3. **EU B2C.** An electronically supplied service to a consumer is taxed
 *    where the consumer is (§ 3a Abs. 5 UStG), declared through the
 *    One-Stop-Shop. The destination country's standard rate, category `S`.
 *    The € 10 000 Bagatellgrenze of § 3a Abs. 5 Satz 3 is deliberately not
 *    applied: it is optional, it would make the rate on an invoice depend on
 *    the running yearly total of every other invoice, and opting into OSS
 *    from the first euro is both allowed and what a hosting business does.
 * 4. **Outside the EU.** The place of supply is abroad for a business
 *    recipient (§ 3a Abs. 2) and for a consumer of an electronically supplied
 *    service (§ 3a Abs. 5), so the sale is simply not taxable in Germany.
 *    0 %, category `O` — outside the scope, not exempt and not zero-rated.
 */

const REVERSE_CHARGE_NOTE =
    "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge) gemäß " +
    "Art. 196 MwStSystRL / § 13b UStG. Die Umsatzsteuer schuldet der " +
    "Leistungsempfänger.";

const NOT_TAXABLE_NOTE =
    "Nicht steuerbare Leistung: Der Leistungsort liegt nach § 3a UStG nicht " +
    "im Inland. Es wird keine deutsche Umsatzsteuer berechnet.";

const OSS_NOTE =
    "Die Umsatzsteuer wird im Bestimmungsland geschuldet und über das " +
    "One-Stop-Shop-Verfahren (§ 18j UStG) erklärt.";

/** True only for an ID that VIES has actually confirmed. */
function hasValidatedVatId(context: TaxContext): boolean {
    const { vatId, vatIdValidatedAt } = context.buyer;

    return Boolean(vatId?.trim()) && vatIdValidatedAt !== null;
}

function decide(context: TaxContext) {
    const seller = normaliseCountry(context.seller.country);
    const buyer = normaliseCountry(context.buyer.country);

    if (!seller) {
        throw new TaxDeterminationError(
            "Das Land des Verkäufers fehlt in den Einstellungen; ohne es " +
                "lässt sich der Steuersatz nicht bestimmen.",
        );
    }

    if (!buyer) {
        throw new TaxDeterminationError(
            "Das Land des Kundenkontos fehlt oder ist kein ISO-Ländercode; " +
                "ohne es lässt sich der Steuersatz nicht bestimmen.",
        );
    }

    return { seller, buyer };
}

function determineRegular(context: TaxContext): TaxDetermination {
    const { seller, buyer } = decide(context);

    if (buyer === seller) {
        if (!isEuCountry(seller)) {
            throw new TaxDeterminationError(
                `Für ${seller} ist kein Regelsteuersatz hinterlegt.`,
            );
        }

        return {
            rateBp: standardRateBp(seller, context.at),
            category: "S",
            rule: "domestic-standard",
        };
    }

    if (isEuCountry(buyer)) {
        if (context.buyer.kind === "company" && hasValidatedVatId(context)) {
            return {
                rateBp: 0,
                category: "AE",
                rule: "eu-b2b-reverse-charge",
            };
        }

        return {
            rateBp: standardRateBp(buyer, context.at),
            category: "S",
            rule: "eu-b2c-oss",
        };
    }

    return { rateBp: 0, category: "O", rule: "non-eu-out-of-scope" };
}

export const regularVat: TaxStrategy = {
    id: "regular-vat",

    determine: determineRegular,

    invoiceNotes(context: TaxContext): string[] {
        switch (determineRegular(context).rule) {
            case "eu-b2b-reverse-charge":
                return [REVERSE_CHARGE_NOTE];
            case "non-eu-out-of-scope":
                return [NOT_TAXABLE_NOTE];
            case "eu-b2c-oss":
                return [OSS_NOTE];
            default:
                return [];
        }
    },
};
