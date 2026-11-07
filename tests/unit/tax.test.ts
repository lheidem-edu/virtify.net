import { describe, expect, it } from "vitest";
import { calculateTotals } from "@/server/billing/invoices/totals";
import {
    isEuCountry,
    normaliseCountry,
    standardRateBp,
    TAX_STRATEGIES,
    type TaxContext,
    TaxDeterminationError,
    taxStrategy,
    vatIdCountry,
} from "@/server/tax";
import { KLEINUNTERNEHMER_NOTE } from "@/server/tax/strategies/kleinunternehmer";

const SELLER = {
    country: "DE",
    vatId: "DE457809315",
    taxNumber: "305/5721/1234",
};

function context(
    buyer: Partial<TaxContext["buyer"]>,
    at = new Date("2026-11-07T10:00:00Z"),
): TaxContext {
    return {
        seller: SELLER,
        buyer: {
            country: "DE",
            kind: "private",
            vatId: null,
            vatIdValidatedAt: null,
            ...buyer,
        },
        at,
        supply: "service",
    };
}

describe("kleinunternehmer", () => {
    const strategy = taxStrategy("kleinunternehmer");

    it("charges nothing, to anybody, anywhere", () => {
        for (const buyer of [
            { country: "DE", kind: "private" as const },
            {
                country: "AT",
                kind: "company" as const,
                vatId: "ATU12345678",
                vatIdValidatedAt: new Date(),
            },
            { country: "US", kind: "company" as const },
            { country: null },
        ]) {
            expect(strategy.determine(context(buyer))).toEqual({
                rateBp: 0,
                category: "E",
                rule: "kleinunternehmer",
            });
        }
    });

    it("prints the sentence § 14 Abs. 4 Nr. 8 UStG asks for, exactly", () => {
        expect(strategy.invoiceNotes(context({}))).toEqual([
            "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
        ]);
        expect(KLEINUNTERNEHMER_NOTE).toBe(
            "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
        );
    });

    it("leaves an invoice's gross equal to its net", () => {
        // 19,99 € monthly plus a 10,00 € setup fee: 29,99 €, no tax line.
        const determination = strategy.determine(context({}));
        const totals = calculateTotals(
            [
                { description: "VPS M", quantity: 1, unitPriceCents: 1999 },
                {
                    description: "Einrichtung",
                    quantity: 1,
                    unitPriceCents: 1000,
                },
            ].map((item) => ({
                ...item,
                unitCode: "MON",
                taxRateBp: determination.rateBp,
                taxCategory: determination.category,
                taxRule: determination.rule,
            })),
        );

        expect(totals.netCents).toBe(2999);
        expect(totals.taxCents).toBe(0);
        expect(totals.grossCents).toBe(2999);
    });
});

describe("regular-vat", () => {
    const strategy = taxStrategy("regular-vat");

    it("is implemented but not the default", () => {
        expect(TAX_STRATEGIES["regular-vat"]).toBe(strategy);
        expect(strategy.id).toBe("regular-vat");
    });

    it("charges 19 % on a German sale, VAT ID or not", () => {
        expect(strategy.determine(context({ country: "DE" }))).toEqual({
            rateBp: 1900,
            category: "S",
            rule: "domestic-standard",
        });

        // Hosting is not a § 13b supply, so a German VAT ID changes nothing.
        expect(
            strategy.determine(
                context({
                    country: "DE",
                    kind: "company",
                    vatId: "DE123456789",
                    vatIdValidatedAt: new Date("2026-01-01T00:00:00Z"),
                }),
            ),
        ).toEqual({ rateBp: 1900, category: "S", rule: "domestic-standard" });

        expect(strategy.invoiceNotes(context({ country: "DE" }))).toEqual([]);
    });

    it("reverse-charges an Austrian business with a validated VAT ID", () => {
        const ctx = context({
            country: "AT",
            kind: "company",
            vatId: "ATU12345678",
            vatIdValidatedAt: new Date("2026-10-01T00:00:00Z"),
        });

        expect(strategy.determine(ctx)).toEqual({
            rateBp: 0,
            category: "AE",
            rule: "eu-b2b-reverse-charge",
        });
        expect(strategy.invoiceNotes(ctx)[0]).toContain(
            "Steuerschuldnerschaft des Leistungsempfängers",
        );
    });

    it("refuses to reverse-charge a VAT ID nobody has checked", () => {
        // § 18e UStG: the seller owes the tax when the number turns out to be
        // wrong, so an unvalidated one is treated as no number at all.
        expect(
            strategy.determine(
                context({
                    country: "AT",
                    kind: "company",
                    vatId: "ATU12345678",
                    vatIdValidatedAt: null,
                }),
            ),
        ).toEqual({ rateBp: 2000, category: "S", rule: "eu-b2c-oss" });
    });

    it("charges the destination rate to an Austrian consumer", () => {
        const ctx = context({ country: "AT", kind: "private" });

        expect(strategy.determine(ctx)).toEqual({
            rateBp: 2000,
            category: "S",
            rule: "eu-b2c-oss",
        });
        expect(strategy.invoiceNotes(ctx)[0]).toContain("One-Stop-Shop");

        // 100,00 € to Austria: 20,00 € tax, 120,00 € gross.
        const totals = calculateTotals([
            {
                description: "VPS M",
                quantity: 1,
                unitCode: "MON",
                unitPriceCents: 10_000,
                taxRateBp: 2000,
                taxCategory: "S",
                taxRule: "eu-b2c-oss",
            },
        ]);

        expect(totals.taxCents).toBe(2000);
        expect(totals.grossCents).toBe(12_000);
    });

    it("does not tax a sale outside the EU in Germany", () => {
        const ctx = context({ country: "US", kind: "company" });

        expect(strategy.determine(ctx)).toEqual({
            rateBp: 0,
            category: "O",
            rule: "non-eu-out-of-scope",
        });
        expect(strategy.invoiceNotes(ctx)[0]).toContain("Nicht steuerbar");

        // A US consumer is the same answer: § 3a Abs. 5 puts the place of an
        // electronically supplied service where the consumer is.
        expect(
            strategy.determine(context({ country: "US", kind: "private" }))
                .rule,
        ).toBe("non-eu-out-of-scope");
    });

    it("refuses to guess when the country is missing", () => {
        expect(() => strategy.determine(context({ country: null }))).toThrow(
            TaxDeterminationError,
        );
        expect(() =>
            strategy.determine(context({ country: "Irgendwo" })),
        ).toThrow(TaxDeterminationError);
    });
});

describe("the EU rate table", () => {
    it("picks the rate by the date the document is finalized", () => {
        // Estonia went 20 % → 22 % → 24 %; Finland 24 % → 25,5 %.
        expect(standardRateBp("EE", new Date("2023-06-01T00:00:00Z"))).toBe(
            2000,
        );
        expect(standardRateBp("EE", new Date("2024-06-01T00:00:00Z"))).toBe(
            2200,
        );
        expect(standardRateBp("EE", new Date("2026-06-01T00:00:00Z"))).toBe(
            2400,
        );
        expect(standardRateBp("FI", new Date("2024-08-31T00:00:00Z"))).toBe(
            2400,
        );
        expect(standardRateBp("FI", new Date("2024-09-01T00:00:00Z"))).toBe(
            2550,
        );
    });

    it("carries a half-point rate without a float", () => {
        // 25,5 % of 100,00 € is 25,50 € exactly.
        const totals = calculateTotals([
            {
                description: "VPS M",
                quantity: 1,
                unitCode: "MON",
                unitPriceCents: 10_000,
                taxRateBp: standardRateBp(
                    "FI",
                    new Date("2026-01-01T00:00:00Z"),
                ),
                taxCategory: "S",
                taxRule: "eu-b2c-oss",
            },
        ]);

        expect(totals.taxCents).toBe(2550);
    });

    it("knows the member states and nothing else", () => {
        expect(isEuCountry("DE")).toBe(true);
        expect(isEuCountry("AT")).toBe(true);
        expect(isEuCountry("GB")).toBe(false);
        expect(isEuCountry("CH")).toBe(false);
        expect(isEuCountry(null)).toBe(false);
    });
});

describe("country normalisation", () => {
    it("accepts a code, a German name and an English one", () => {
        expect(normaliseCountry("de")).toBe("DE");
        expect(normaliseCountry("Deutschland")).toBe("DE");
        expect(normaliseCountry("Germany")).toBe("DE");
        expect(normaliseCountry(" Österreich ")).toBe("AT");
    });

    it("maps the codes the EU uses that are not ISO", () => {
        expect(normaliseCountry("EL")).toBe("GR");
        expect(normaliseCountry("UK")).toBe("GB");
        expect(vatIdCountry("EL123456789")).toBe("GR");
        expect(vatIdCountry("ATU12345678")).toBe("AT");
    });

    it("gives up rather than guessing", () => {
        expect(normaliseCountry("Irgendwo")).toBeNull();
        expect(normaliseCountry("")).toBeNull();
        expect(normaliseCountry(null)).toBeNull();
        expect(vatIdCountry("12345")).toBeNull();
    });
});

describe("the address block", () => {
    const buyer = {
        name: "Maria Musterfrau",
        company: "Beispiel GmbH",
        street: "Musterstraße 12",
        postalCode: "33602",
        city: "Bielefeld",
        country: "DE",
    };

    it("leaves the home country off, as DIN 5008 wants", async () => {
        const { formatRecipient } = await import(
            "@/server/documents/repository"
        );

        expect(formatRecipient(buyer)).toBe(
            "Beispiel GmbH\nMaria Musterfrau\nMusterstraße 12\n33602 Bielefeld",
        );
        // "Deutschland" on the settings row is the same country as "DE".
        expect(formatRecipient(buyer, "Deutschland")).toBe(
            formatRecipient(buyer),
        );
    });

    it("writes a foreign country out in German", async () => {
        const { formatRecipient } = await import(
            "@/server/documents/repository"
        );

        expect(formatRecipient({ ...buyer, country: "AT" })).toContain(
            "Österreich",
        );
        expect(formatRecipient({ ...buyer, country: "US" })).toContain(
            "Vereinigte Staaten",
        );
        // A code nobody has a name for is still better than nothing.
        expect(formatRecipient({ ...buyer, country: "ZW" })).toContain("ZW");
    });
});
