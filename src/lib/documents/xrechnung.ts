import type { Totals } from "@/lib/documents/totals";
import { operator, site } from "@/lib/site";

/**
 * XRechnung in UN/CEFACT CII syntax (EN 16931 / CIUS XRechnung 3.0).
 *
 * The seller is a Kleinunternehmer under § 19 UStG, so every line carries VAT
 * category "E" (exempt) at 0 % with an exemption reason, and the document
 * total tax is zero. That is the encoding the FeRD guidance gives for
 * § 19 — a plain 0 % standard rate would assert a taxable supply at zero,
 * which is a different statement.
 *
 * The XML is generated directly rather than through a library: the Node
 * options are all at 0.0.x–0.1.x, and this is a fixed, narrow shape.
 */

export type XRechnungInput = {
    number: string;
    /**
     * UNTDID 1001: 380 is a commercial invoice, 384 a corrected one. A Storno
     * restates the original's lines with negated amounts, which is a
     * correction — a validator reading 380 would reject the negative total.
     */
    typeCode?: "380" | "384";
    issuedAt: Date;
    dueAt: Date | null;
    buyerReference: string;
    servicePeriod: { start: Date | null; end: Date | null };
    note: string | null;
    buyer: {
        name: string;
        street: string | null;
        postalCode: string | null;
        city: string | null;
        country: string | null;
        vatId: string | null;
        email: string;
    };
    totals: Totals;
};

const EXEMPTION_REASON =
    "Kleinunternehmer gemäß § 19 UStG — es wird keine Umsatzsteuer berechnet.";

function escapeXml(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/** EN 16931 dates use format code 102: YYYYMMDD. */
function formatDate(value: Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}${month}${day}`;
}

/** Amounts are decimal with two places, never cents, in the XML. */
function amount(cents: number) {
    return (cents / 100).toFixed(2);
}

function line(item: XRechnungInput["totals"]["lines"][number]) {
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
          <ram:CategoryCode>E</ram:CategoryCode>
          <ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${amount(item.lineTotalCents)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
}

export function renderXRechnung(input: XRechnungInput) {
    const { totals, buyer } = input;

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
    </ram:IssueDateTime>${
        input.note
            ? `
    <ram:IncludedNote><ram:Content>${escapeXml(input.note)}</ram:Content></ram:IncludedNote>`
            : ""
    }
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${totals.lines.map(line).join("")}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>${escapeXml(input.buyerReference)}</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>${escapeXml(operator.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${escapeXml(operator.city.split(" ")[0])}</ram:PostcodeCode>
          <ram:LineOne>${escapeXml(operator.street)}</ram:LineOne>
          <ram:CityName>${escapeXml(operator.city.split(" ").slice(1).join(" "))}</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">${escapeXml(operator.email)}</ram:URIID>
        </ram:URIUniversalCommunication>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${escapeXml(operator.vatId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>
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
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>0.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:ExemptionReason>${escapeXml(EXEMPTION_REASON)}</ram:ExemptionReason>
        <ram:BasisAmount>${amount(totals.netCents)}</ram:BasisAmount>
        <ram:CategoryCode>E</ram:CategoryCode>
        <ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>${period}${
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
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}

export const XRECHNUNG_FILENAME = (number: string) =>
    `${site.name}-${number}.xml`.replace(/[^\w.-]/g, "-");
