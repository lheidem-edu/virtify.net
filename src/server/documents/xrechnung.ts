import type { DocumentTotals } from "@/server/billing/invoices/totals";
import type { PdfSeller } from "@/server/documents/pdf";

/**
 * XRechnung in UN/CEFACT CII syntax (EN 16931 / CIUS XRechnung 3.0).
 *
 * Everything about tax comes from the document's own snapshot — the category,
 * the rate and, where no tax is charged, the reason. Under § 19 UStG that is
 * category `E` at 0 % with an exemption reason, which is the encoding the
 * FeRD guidance gives: a plain 0 % standard rate would assert a taxable
 * supply charged at nothing, which is a different statement. Under regular
 * VAT the same code produces `S` at the applicable rate, `AE` for a reverse
 * charge and `O` for a supply outside the scope of German VAT.
 *
 * The XML is generated directly rather than through a library: the Node
 * options are all at 0.0.x–0.1.x, and this is a fixed, narrow shape.
 */

export type XRechnungInput = {
    /** The seller as frozen on the document, never a live lookup. */
    seller: PdfSeller;
    siteName: string;
    number: string;
    /**
     * UNTDID 1001: 380 is a commercial invoice, 381 a credit note. A
     * Rechnungskorrektur is its own document here, so it is a 381 with
     * positive amounts rather than a 380 with negative ones.
     */
    typeCode?: "380" | "381";
    issuedAt: Date;
    dueAt: Date | null;
    buyerReference: string;
    servicePeriod: { start: Date | null; end: Date | null };
    note: string | null;
    /** Notes the tax strategy requires on the document. */
    taxNotes?: string[];
    buyer: {
        name: string;
        street: string | null;
        postalCode: string | null;
        city: string | null;
        country: string | null;
        vatId: string | null;
        email: string;
    };
    /** The invoice a credit note corrects, for BT-25. */
    precedingNumber?: string | null;
    precedingIssuedAt?: Date | null;
    totals: DocumentTotals;
};

/**
 * EN 16931 BR-E-10, BR-AE-10, BR-O-10: a category that charges no tax has to
 * say why. The sentence is the tax strategy's; this is the fallback for a
 * document from before the strategies existed.
 */
const DEFAULT_EXEMPTION = {
    E: "Kleinunternehmer gemäß § 19 UStG — es wird keine Umsatzsteuer berechnet.",
    AE: "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge).",
    O: "Nicht steuerbar — der Leistungsort liegt nicht im Inland.",
    G: "Steuerfreie Ausfuhrlieferung.",
    Z: "Nullsatz.",
    S: "",
} as const;

function escapeXml(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * EN 16931 dates use format code 102: YYYYMMDD — the *Berlin* calendar day.
 *
 * Reading the UTC day instead would put a different Ausstellungsdatum (BT-2)
 * in the XML from the one the PDF prints: `issuedAt` is the raw finalization
 * instant, and `src/lib/format.ts` renders it in Europe/Berlin, as
 * `berlinYear()` does for the invoice number. An invoice finalized at 00:30
 * on 1 January is numbered RE-2027-0001 and dated 01.01.2027 on paper; with
 * UTC parts its XML said 20261231 — a 2027 number declaring a 2026 issue
 * date, which is the wrong VAT period for whoever books it.
 */
const BERLIN_DAY = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

function formatDate(value: Date) {
    // en-CA gives YYYY-MM-DD, so the separators are all that have to go.
    return BERLIN_DAY.format(value).replace(/-/g, "");
}

/** Amounts are decimal with two places, never cents, in the XML. */
function amount(cents: number) {
    return (cents / 100).toFixed(2);
}

/** `1900` → "19.00". The XML wants a percentage, not basis points. */
function rate(rateBp: number) {
    return (rateBp / 100).toFixed(2);
}

/**
 * "32832 Augustdorf" is one settings field and two XML elements. Splitting on
 * the first space is what the old code did and what the operator's own
 * address needs; an address without a leading postcode falls back to putting
 * everything in the city, which is better than inventing a postcode.
 */
function splitCity(value: string) {
    const match = /^(\d{4,6})\s+(.*)$/.exec(value.trim());

    return match
        ? { postalCode: match[1], city: match[2] }
        : { postalCode: "", city: value.trim() };
}

function line(item: DocumentTotals["lines"][number]) {
    const period =
        item.servicePeriodStart || item.servicePeriodEnd
            ? `
        <ram:BillingSpecifiedPeriod>${
            item.servicePeriodStart
                ? `
          <ram:StartDateTime><udt:DateTimeString format="102">${formatDate(item.servicePeriodStart)}</udt:DateTimeString></ram:StartDateTime>`
                : ""
        }${
            item.servicePeriodEnd
                ? `
          <ram:EndDateTime><udt:DateTimeString format="102">${formatDate(item.servicePeriodEnd)}</udt:DateTimeString></ram:EndDateTime>`
                : ""
        }
        </ram:BillingSpecifiedPeriod>`
            : "";

    return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${item.position}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${escapeXml(item.description)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${amount(item.unitPriceCents)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${escapeXml(item.unitCode)}">${item.quantity}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${item.taxCategory}</ram:CategoryCode>${
              // BR-O-5: a line that is "not subject to VAT" shall not carry an
              // Invoiced item VAT rate (BT-152) at all. A 0.00 there would
              // assert a rate of nothing, which is the very distinction
              // category O exists to avoid. Every other category wants the
              // element — BR-E-5 and BR-AE-5 positively require the zero.
              item.taxCategory === "O"
                  ? ""
                  : `
          <ram:RateApplicablePercent>${rate(item.taxRateBp)}</ram:RateApplicablePercent>`
}
        </ram:ApplicableTradeTax>${period}
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${amount(item.netCents)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
}

export function renderXRechnung(input: XRechnungInput) {
    const { totals, buyer, seller } = input;
    const sellerAddress = splitCity(seller.city);
    const exemptionReason = input.taxNotes?.join(" ") || null;

    const period =
        input.servicePeriod.start || input.servicePeriod.end
            ? `
        <ram:BillingSpecifiedPeriod>${
            input.servicePeriod.start
                ? `
          <ram:StartDateTime><udt:DateTimeString format="102">${formatDate(input.servicePeriod.start)}</udt:DateTimeString></ram:StartDateTime>`
                : ""
        }${
            input.servicePeriod.end
                ? `
          <ram:EndDateTime><udt:DateTimeString format="102">${formatDate(input.servicePeriod.end)}</udt:DateTimeString></ram:EndDateTime>`
                : ""
        }
        </ram:BillingSpecifiedPeriod>`
            : "";

    // BR-CO-17: one ApplicableTradeTax per category and rate, with the basis
    // it was computed on. That is exactly what `totals.groups` is.
    const taxes = totals.groups
        .map((group) => {
            const reason =
                group.category === "S"
                    ? ""
                    : `
        <ram:ExemptionReason>${escapeXml(
            exemptionReason ??
                DEFAULT_EXEMPTION[
                    group.category as keyof typeof DEFAULT_EXEMPTION
                ] ??
                "",
        )}</ram:ExemptionReason>`;

            return `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${amount(group.taxCents)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>${reason}
        <ram:BasisAmount>${amount(group.netCents)}</ram:BasisAmount>
        <ram:CategoryCode>${group.category}</ram:CategoryCode>
        <ram:RateApplicablePercent>${rate(group.rateBp)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`;
        })
        .join("");

    const sellerRegistrations = [
        seller.vatId
            ? `
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${escapeXml(seller.vatId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>`
            : "",
        // schemeID FC is the Steuernummer — what a Kleinunternehmer carries
        // when they hold no USt-IdNr.
        seller.taxNumber
            ? `
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="FC">${escapeXml(seller.taxNumber)}</ram:ID>
        </ram:SpecifiedTaxRegistration>`
            : "",
    ].join("");

    const notes = [input.note, ...(input.taxNotes ?? [])].filter(
        (value): value is string => Boolean(value),
    );

    /**
     * BG-16 PAYMENT INSTRUCTIONS with BT-81. The document declares the
     * XRechnung 3.0 CIUS, and BR-DE-1 makes this group mandatory there — the
     * KoSIT validator rejects an invoice without it, however valid the plain
     * EN 16931 core would be. The bank details are already on the frozen
     * seller snapshot and already printed on the PDF; nothing new is
     * disclosed by putting them where a machine can read them.
     *
     * UNTDID 4461 code 58 is a SEPA credit transfer, which is what the
     * GiroCode on the PDF encodes; with no IBAN on file the only honest code
     * is 1, "instrument not defined". BR-DE-23 then does not apply, because
     * it hangs off code 58.
     */
    const paymentMeans = seller.iban
        ? `
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>${escapeXml(seller.iban.replace(/\s/g, ""))}</ram:IBANID>
          <ram:AccountName>${escapeXml(seller.name)}</ram:AccountName>
        </ram:PayeePartyCreditorFinancialAccount>${
            seller.bic
                ? `
        <ram:PayeeSpecifiedCreditorFinancialInstitution>
          <ram:BICID>${escapeXml(seller.bic.replace(/\s/g, ""))}</ram:BICID>
        </ram:PayeeSpecifiedCreditorFinancialInstitution>`
                : ""
        }
      </ram:SpecifiedTradeSettlementPaymentMeans>`
        : `
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>1</ram:TypeCode>
      </ram:SpecifiedTradeSettlementPaymentMeans>`;

    /**
     * BG-6 SELLER CONTACT. BR-DE-2 makes the group mandatory and BR-DE-5/6/7
     * each of BT-41 (contact point), BT-42 (telephone) and BT-43 (email).
     * There is no separate contact person in the settings, so the operator's
     * own name is the contact point — which is what the PDF footer says too.
     */
    const sellerContact = `
        <ram:DefinedTradeContact>
          <ram:PersonName>${escapeXml(seller.name)}</ram:PersonName>
          <ram:TelephoneUniversalCommunication>
            <ram:CompleteNumber>${escapeXml(seller.phone)}</ram:CompleteNumber>
          </ram:TelephoneUniversalCommunication>
          <ram:EmailURIUniversalCommunication>
            <ram:URIID>${escapeXml(seller.email)}</ram:URIID>
          </ram:EmailURIUniversalCommunication>
        </ram:DefinedTradeContact>`;

    const preceding = input.precedingNumber
        ? `
      <ram:InvoiceReferencedDocument>
        <ram:IssuerAssignedID>${escapeXml(input.precedingNumber)}</ram:IssuerAssignedID>${
            input.precedingIssuedAt
                ? `
        <ram:FormattedIssueDateTime><udt:DateTimeString format="102">${formatDate(input.precedingIssuedAt)}</udt:DateTimeString></ram:FormattedIssueDateTime>`
                : ""
        }
      </ram:InvoiceReferencedDocument>`
        : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${escapeXml(input.number)}</ram:ID>
    <ram:TypeCode>${input.typeCode ?? "380"}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${formatDate(input.issuedAt)}</udt:DateTimeString>
    </ram:IssueDateTime>${notes
        .map(
            (note) => `
    <ram:IncludedNote><ram:Content>${escapeXml(note)}</ram:Content></ram:IncludedNote>`,
        )
        .join("")}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${totals.lines.map(line).join("")}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>${escapeXml(input.buyerReference)}</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>${escapeXml(seller.name)}</ram:Name>${sellerContact}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${escapeXml(sellerAddress.postalCode)}</ram:PostcodeCode>
          <ram:LineOne>${escapeXml(seller.street)}</ram:LineOne>
          <ram:CityName>${escapeXml(sellerAddress.city)}</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">${escapeXml(seller.email)}</ram:URIID>
        </ram:URIUniversalCommunication>${sellerRegistrations}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${escapeXml(buyer.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${escapeXml(buyer.postalCode ?? "")}</ram:PostcodeCode>
          <ram:LineOne>${escapeXml(buyer.street ?? "")}</ram:LineOne>
          <ram:CityName>${escapeXml(buyer.city ?? "")}</ram:CityName>
          <ram:CountryID>${escapeXml((buyer.country ?? "DE").slice(0, 2).toUpperCase())}</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">${escapeXml(buyer.email)}</ram:URIID>
        </ram:URIUniversalCommunication>${
            buyer.vatId
                ? `
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${escapeXml(buyer.vatId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>`
                : ""
        }
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery />
    <ram:ApplicableHeaderTradeSettlement>
      <ram:PaymentReference>${escapeXml(input.number)}</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>${paymentMeans}${taxes}${period}${
          input.dueAt
              ? `
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${formatDate(input.dueAt)}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>`
              : ""
}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amount(totals.netCents)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${amount(totals.netCents)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${amount(totals.taxCents)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${amount(totals.grossCents)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${amount(totals.grossCents)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>${preceding}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}

export const XRECHNUNG_FILENAME = (siteName: string, number: string) =>
    `${siteName}-${number}.xml`.replace(/[^\w.-]/g, "-");
