import { describe, expect, it } from "vitest";
import {
    GiroCodeError,
    giroCodePayload,
    giroCodeSymbol,
    utf8Bytes,
} from "@/lib/giro-code";

const BASE = {
    name: "Luca Heidemann",
    iban: "DE64 5002 4024 8341 7339 30",
    bic: "DEFFDEFFXXX",
    amountCents: 1999,
    remittance: "RE-2026-0009",
};

describe("the EPC payload", () => {
    it("is the eleven lines EPC069-12 prescribes, in order", () => {
        expect(giroCodePayload(BASE).split("\n")).toEqual([
            "BCD",
            "002",
            "1",
            "SCT",
            "DEFFDEFFXXX",
            "Luca Heidemann",
            "DE64500240248341733930",
            "EUR19.99",
            "",
            "",
            "RE-2026-0009",
        ]);
    });

    it("writes the amount with two decimals, always", () => {
        const amount = (cents: number) =>
            giroCodePayload({ ...BASE, amountCents: cents }).split("\n")[7];

        expect(amount(1)).toBe("EUR0.01");
        expect(amount(100)).toBe("EUR1.00");
        expect(amount(123_456)).toBe("EUR1234.56");
        expect(amount(100_000)).toBe("EUR1000.00");
    });

    it("leaves the BIC out where there is none — version 002 allows it", () => {
        expect(giroCodePayload({ ...BASE, bic: null }).split("\n")[4]).toBe("");
    });

    it("refuses an amount a transfer cannot carry", () => {
        expect(() => giroCodePayload({ ...BASE, amountCents: 0 })).toThrow(
            GiroCodeError,
        );
        expect(() => giroCodePayload({ ...BASE, amountCents: -100 })).toThrow(
            GiroCodeError,
        );
        expect(() =>
            giroCodePayload({ ...BASE, amountCents: 100_000_000_000 }),
        ).toThrow(GiroCodeError);
    });

    it("refuses something that is not an IBAN", () => {
        expect(() => giroCodePayload({ ...BASE, iban: "1234" })).toThrow(
            GiroCodeError,
        );
    });

    it("clips the name to 70 bytes, counting umlauts as two", () => {
        // 70 "ü" are 140 bytes in UTF-8, so only 35 of them fit.
        const name = "ü".repeat(70);
        const clipped = giroCodePayload({ ...BASE, name }).split("\n")[5];

        expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(70);
        expect(clipped).toBe("ü".repeat(35));
    });

    it("clips the remittance to 140 characters", () => {
        const remittance = "A".repeat(200);
        const clipped = giroCodePayload({ ...BASE, remittance }).split(
            "\n",
        )[10];

        expect(clipped).toHaveLength(140);
    });

    it("stays inside the 331 bytes the specification allows", () => {
        const payload = giroCodePayload({
            ...BASE,
            name: "ä".repeat(70),
            remittance: "ö".repeat(140),
        });

        expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(331);
    });
});

describe("the symbol", () => {
    it("is a square matrix with a path over it", () => {
        const symbol = giroCodeSymbol(BASE);

        // Version 1 is 21 modules, version 40 is 177. Anything outside that
        // is not a QR code.
        expect(symbol.modules).toBeGreaterThanOrEqual(21);
        expect(symbol.modules).toBeLessThanOrEqual(177);
        expect(symbol.path).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
    });

    it("has the three finder patterns in the corners", () => {
        // Every QR code starts each of three corners with a 7×7 finder, so
        // the first run of the first row is exactly seven modules wide.
        const symbol = giroCodeSymbol(BASE);

        expect(symbol.path.startsWith("M0 0h7v1h-7z")).toBe(true);
    });

    it("produces the same symbol for the same payload", () => {
        expect(giroCodeSymbol(BASE)).toEqual(giroCodeSymbol(BASE));
    });

    it("encodes an umlaut as UTF-8 rather than mangling it", () => {
        // The encoder's own conversion keeps only the low byte of each
        // character, which would silently corrupt a beneficiary's name — and
        // the table of alternatives it offers exists only in its CommonJS
        // build, so this module does the encoding itself.
        const plain = giroCodeSymbol({ ...BASE, name: "Mueller GmbH" });
        const umlaut = giroCodeSymbol({ ...BASE, name: "Müller GmbH" });

        expect(umlaut.path).not.toBe(plain.path);
        // One character fewer but one byte more, so the symbol does not shrink.
        expect(umlaut.modules).toBe(plain.modules);
    });

    it("hands the encoder real UTF-8 bytes", () => {
        // Line 3 of the payload says "1" — UTF-8. "ü" is C3 BC there and FC
        // in Latin-1, and the encoder's own conversion would have produced
        // the second. A bank scanning the code reads the bytes, not the
        // string this process happens to hold.
        expect(utf8Bytes("ü")).toEqual([0xc3, 0xbc]);
        expect(utf8Bytes("Müller")).toEqual([
            0x4d, 0xc3, 0xbc, 0x6c, 0x6c, 0x65, 0x72,
        ]);
        expect(utf8Bytes("BCD")).toEqual([0x42, 0x43, 0x44]);
    });
});
