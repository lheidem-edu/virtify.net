import { describe, expect, it } from "vitest";
import type { DocumentTotals } from "@/server/billing/invoices/totals";
import { calculateTotals } from "@/server/billing/invoices/totals";
import type { PdfSeller } from "@/server/documents/pdf";
import { renderXRechnung } from "@/server/documents/xrechnung";

/**
 * The e-invoice, which is the only form of the document a machine reads.
 *
 * The file declares conformance to the XRechnung 3.0 CIUS, so it is measured
 * against that: the BR-DE rules the CIUS adds on top of EN 16931 are not
 * optional once the guideline identifier names them.
 */

const SELLER: PdfSeller = {
    name: "virtify",
    street: "Musterstraße 2",
    city: "12345 Musterstadt",
    country: "DE",
    email: "rechnung@virtify.test",
    phone: "+49 30 123456",
    vatId: null,
    taxNumber: "305/5721/1234",
    bankName: "Musterbank",
    iban: "DE02 1203 0000 0000 2020 51",
    bic: "BYLADEM1001",
};

const BUYER = {
    name: "Musterfirma GmbH",
    street: "Musterweg 1",
    postalCode: "54321",
    city: "Andernorts",
    country: "DE",
    vatId: null,
    email: "kunde@example.test",
};

function totalsOf(
    category: "E" | "S" | "O" | "AE",
    rateBp: number,
): DocumentTotals {
    return calculateTotals([
        {
            description: "VPS M — November 2026",
            detail: null,
            quantity: 1,
            unitCode: "MON",
            unitPriceCents: 1999,
            taxRateBp: rateBp,
            taxCategory: category,
            taxRule: "kleinunternehmer",
        },
    ]);
}

function render(over: Partial<Parameters<typeof renderXRechnung>[0]> = {}) {
    return renderXRechnung({
        seller: SELLER,
        siteName: "virtify",
        number: "RE-2026-0042",
        typeCode: "380",
        issuedAt: new Date("2026-11-07T10:00:00Z"),
        dueAt: new Date("2026-11-21T10:00:00Z"),
        buyerReference: "10001",
        servicePeriod: { start: null, end: null },
        note: null,
        taxNotes: ["Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."],
        buyer: BUYER,
        totals: totalsOf("E", 0),
        ...over,
    });
}

/** The text of the first element with this name, anywhere in the document. */
function tag(xml: string, name: string): string | null {
    const match = new RegExp(`<ram:${name}[^>]*>([^<]*)</ram:${name}>`).exec(
        xml,
    );

    return match ? match[1] : null;
}

describe("the XRechnung the panel generates", () => {
    it("carries the § 19 snapshot as category E with its reason", () => {
        const xml = render();

        expect(xml).toContain("<ram:CategoryCode>E</ram:CategoryCode>");
        expect(xml).toContain(
            "<ram:ExemptionReason>Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.</ram:ExemptionReason>",
        );
        // BR-E-5 wants the zero rate written out, unlike category O below.
        expect(xml).toContain(
            "<ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>",
        );
        expect(tag(xml, "GrandTotalAmount")).toBe("19.99");
        expect(tag(xml, "TaxTotalAmount")).toBe("0.00");
    });

    describe("the dates it states", () => {
        /**
         * BT-2 is the Ausstellungsdatum § 14 Abs. 4 Nr. 3 UStG requires. The
         * PDF prints it in Europe/Berlin and `berlinYear()` numbers the
         * invoice by the same calendar, so the XML has to agree — reading the
         * UTC day instead put a 2027-numbered invoice's issue date in 2026.
         */
        it("reads the Berlin calendar day, not the UTC one", () => {
            const xml = render({
                number: "RE-2027-0001",
                issuedAt: new Date("2026-12-31T23:30:00Z"),
                dueAt: new Date("2027-01-14T23:30:00Z"),
            });

            expect(tag(xml, "ID")).toBe(
                "urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0",
            );
            expect(xml).toContain(
                '<udt:DateTimeString format="102">20270101</udt:DateTimeString>',
            );
            expect(xml).not.toContain(
                '<udt:DateTimeString format="102">20261231</udt:DateTimeString>',
            );
        });

        it("agrees with the UTC day for an ordinary daytime instant", () => {
            const xml = render({
                issuedAt: new Date("2026-11-07T10:00:00Z"),
            });

            expect(xml).toContain(
                '<udt:DateTimeString format="102">20261107</udt:DateTimeString>',
            );
        });

        it("renders a summer instant in CEST", () => {
            // 22:30 UTC on 14 July is already the 15th in Berlin.
            const xml = render({
                issuedAt: new Date("2026-07-14T22:30:00Z"),
                dueAt: null,
            });

            expect(xml).toContain(
                '<udt:DateTimeString format="102">20260715</udt:DateTimeString>',
            );
        });
    });

    describe("what the XRechnung 3.0 CIUS makes mandatory", () => {
        // BR-DE-1: the document must carry PAYMENT INSTRUCTIONS (BG-16).
        it("states how to pay, with the IBAN the PDF already prints", () => {
            const xml = render();

            expect(xml).toContain("<ram:SpecifiedTradeSettlementPaymentMeans>");
            // UNTDID 4461 code 58 — SEPA credit transfer, as the GiroCode.
            expect(xml).toContain("<ram:TypeCode>58</ram:TypeCode>");
            // Spaces are not part of an IBAN (BT-84).
            expect(xml).toContain(
                "<ram:IBANID>DE02120300000000202051</ram:IBANID>",
            );
            expect(xml).toContain("<ram:BICID>BYLADEM1001</ram:BICID>");
            expect(tag(xml, "PaymentReference")).toBe("RE-2026-0042");
        });

        it("falls back to an undefined instrument with no IBAN on file", () => {
            const xml = render({
                seller: { ...SELLER, iban: "", bic: "" },
            });

            // BR-DE-1 still wants the group; code 58 without BT-84 would
            // break BR-DE-23, so the honest code is 1.
            expect(xml).toContain("<ram:SpecifiedTradeSettlementPaymentMeans>");
            expect(xml).toContain("<ram:TypeCode>1</ram:TypeCode>");
            expect(xml).not.toContain("<ram:IBANID>");
        });

        // BR-DE-2 and BR-DE-5/6/7: SELLER CONTACT with BT-41, BT-42, BT-43.
        it("names a seller contact with a telephone number and an address", () => {
            const xml = render();
            const contact =
                /<ram:DefinedTradeContact>[\s\S]*?<\/ram:DefinedTradeContact>/.exec(
                    xml,
                )?.[0];

            expect(contact).toBeTruthy();
            expect(contact).toContain(
                "<ram:PersonName>virtify</ram:PersonName>",
            );
            expect(contact).toContain(
                "<ram:CompleteNumber>+49 30 123456</ram:CompleteNumber>",
            );
            expect(contact).toContain(
                "<ram:URIID>rechnung@virtify.test</ram:URIID>",
            );
        });

        it("puts the contact where CII expects it — before the address", () => {
            // The sequence inside SellerTradeParty is fixed by the schema;
            // an element in the wrong order is a parse error, not a warning.
            const xml = render();
            const seller =
                /<ram:SellerTradeParty>[\s\S]*?<\/ram:SellerTradeParty>/.exec(
                    xml,
                )?.[0] as string;

            expect(seller.indexOf("<ram:DefinedTradeContact>")).toBeGreaterThan(
                seller.indexOf("<ram:Name>"),
            );
            expect(seller.indexOf("<ram:DefinedTradeContact>")).toBeLessThan(
                seller.indexOf("<ram:PostalTradeAddress>"),
            );
        });

        it("puts the payment means before the tax breakdown", () => {
            const xml = render();
            const settlement =
                /<ram:ApplicableHeaderTradeSettlement>[\s\S]*?<\/ram:ApplicableHeaderTradeSettlement>/.exec(
                    xml,
                )?.[0] as string;

            // indexOf returns -1 for an element that is simply missing, and
            // -1 is less than everything: assert presence before order.
            expect(settlement).toContain("<ram:PaymentReference>");
            expect(settlement).toContain(
                "<ram:SpecifiedTradeSettlementPaymentMeans>",
            );

            expect(settlement.indexOf("<ram:PaymentReference>")).toBeLessThan(
                settlement.indexOf("<ram:InvoiceCurrencyCode>"),
            );
            expect(
                settlement.indexOf(
                    "<ram:SpecifiedTradeSettlementPaymentMeans>",
                ),
            ).toBeLessThan(settlement.indexOf("<ram:ApplicableTradeTax>"));
        });
    });

    describe("categories that charge no tax", () => {
        /**
         * BR-O-5: a line that is not subject to VAT shall not carry an
         * invoiced item VAT rate at all. `0.00` there would assert a rate of
         * nothing, which is a different statement from being out of scope —
         * exactly the distinction category O exists to draw.
         */
        it("omits the line rate for an out-of-scope supply", () => {
            const xml = render({
                totals: totalsOf("O", 0),
                taxNotes: ["Nicht steuerbare Leistung."],
            });

            const lineBlock =
                /<ram:IncludedSupplyChainTradeLineItem>[\s\S]*?<\/ram:IncludedSupplyChainTradeLineItem>/.exec(
                    xml,
                )?.[0] as string;

            expect(lineBlock).toContain(
                "<ram:CategoryCode>O</ram:CategoryCode>",
            );
            expect(lineBlock).not.toContain("RateApplicablePercent");

            // The breakdown keeps its rate: no BR-O rule forbids BT-119, and
            // BR-CO-17 is satisfied by 0 % of the basis being 0.
            const breakdown =
                /<ram:ApplicableTradeTax>[\s\S]*?<\/ram:ApplicableTradeTax>\s*<ram:BillingSpecifiedPeriod|<ram:ApplicableTradeTax>\s*<ram:CalculatedAmount>[\s\S]*?<\/ram:ApplicableTradeTax>/.exec(
                    xml,
                )?.[0] as string;
            expect(breakdown).toContain(
                "<ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>",
            );
        });

        it("keeps the line rate for a reverse charge, as BR-AE-5 wants", () => {
            const xml = render({
                totals: totalsOf("AE", 0),
                taxNotes: ["Steuerschuldnerschaft des Leistungsempfängers."],
            });

            const lineBlock =
                /<ram:IncludedSupplyChainTradeLineItem>[\s\S]*?<\/ram:IncludedSupplyChainTradeLineItem>/.exec(
                    xml,
                )?.[0] as string;

            expect(lineBlock).toContain(
                "<ram:CategoryCode>AE</ram:CategoryCode>",
            );
            expect(lineBlock).toContain(
                "<ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>",
            );
        });

        it("writes a standard-rate line with its rate and tax", () => {
            const xml = render({
                totals: totalsOf("S", 1900),
                taxNotes: [],
            });

            expect(xml).toContain(
                "<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>",
            );
            // 19 % of 19,99 € = 3,7981 € → 3,80 €, per rate on the group.
            expect(tag(xml, "TaxTotalAmount")).toBe("3.80");
            expect(tag(xml, "GrandTotalAmount")).toBe("23.79");
            expect(xml).not.toContain("<ram:ExemptionReason>");
        });
    });

    it("references the invoice a correction reverses", () => {
        const xml = render({
            typeCode: "381",
            number: "RK-2026-0001",
            dueAt: null,
            precedingNumber: "RE-2026-0042",
            precedingIssuedAt: new Date("2026-11-07T10:00:00Z"),
        });

        expect(xml).toContain("<ram:TypeCode>381</ram:TypeCode>");
        expect(xml).toContain(
            "<ram:IssuerAssignedID>RE-2026-0042</ram:IssuerAssignedID>",
        );
    });

    it("escapes what a customer typed", () => {
        const xml = render({
            buyer: { ...BUYER, name: 'Müller & Söhne <"GmbH">' },
        });

        expect(xml).toContain("Müller &amp; Söhne &lt;&quot;GmbH&quot;&gt;");
        expect(xml).not.toContain('<"GmbH">');
    });
});
