import { describe, expect, it } from "vitest";
import { fromDecimalString, toDecimalString } from "@/lib/money";
import {
    receivedFrom,
    settlementFor,
} from "@/server/payments/settlement";

/**
 * The arithmetic of a payment, in concrete cents.
 *
 * Everything in this file is about one claim: **what an invoice is worth is
 * the document's business, and what arrived is the payment's.** A payment
 * never recomputes a total — it compares two integers and says what state
 * that leaves the invoice in.
 */

describe("settlementFor", () => {
    it("leaves an invoice open when nothing has arrived", () => {
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 0,
            receivedCents: 0,
        });

        expect(result).toEqual({
            dueCents: 2999,
            paidCents: 0,
            outstandingCents: 2999,
            overpaymentCents: 0,
            status: "unpaid",
        });
    });

    it("settles an invoice paid to the cent", () => {
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 0,
            receivedCents: 2999,
        });

        expect(result.status).toBe("paid");
        expect(result.paidCents).toBe(2999);
        expect(result.outstandingCents).toBe(0);
        expect(result.overpaymentCents).toBe(0);
    });

    it("a part payment leaves the invoice open, not paid", () => {
        // 29,99 € invoiced, 10,00 € transferred.
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 0,
            receivedCents: 1000,
        });

        expect(result.status).toBe("partial");
        expect(result.paidCents).toBe(1000);
        expect(result.outstandingCents).toBe(1999);
        expect(result.overpaymentCents).toBe(0);
    });

    it("one cent short is still open", () => {
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 0,
            receivedCents: 2998,
        });

        expect(result.status).toBe("partial");
        expect(result.outstandingCents).toBe(1);
    });

    it("an overpayment settles the invoice and leaves the rest over", () => {
        // 29,99 € invoiced, 50,00 € transferred: 20,01 € becomes credit and
        // the invoice is paid, not "paid 50,00 €".
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 0,
            receivedCents: 5000,
        });

        expect(result.status).toBe("paid");
        expect(result.paidCents).toBe(2999);
        expect(result.outstandingCents).toBe(0);
        expect(result.overpaymentCents).toBe(2001);
    });

    it("a correction reduces what is owed, so the same money settles it", () => {
        // 29,99 € invoiced, 10,00 € credited by a Rechnungskorrektur,
        // 19,99 € transferred.
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 1000,
            receivedCents: 1999,
        });

        expect(result.dueCents).toBe(1999);
        expect(result.status).toBe("paid");
        expect(result.overpaymentCents).toBe(0);
    });

    it("money paid before a correction turns into credit afterwards", () => {
        // Paid in full, then half of it credited: the invoice still owes
        // nothing, and the difference is the customer's.
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 1000,
            receivedCents: 2999,
        });

        expect(result.dueCents).toBe(1999);
        expect(result.paidCents).toBe(1999);
        expect(result.overpaymentCents).toBe(1000);
        expect(result.status).toBe("paid");
    });

    it("a fully credited invoice owes nothing, so everything is credit", () => {
        const result = settlementFor({
            grossCents: 2999,
            creditedCents: 2999,
            receivedCents: 2999,
        });

        expect(result.dueCents).toBe(0);
        expect(result.paidCents).toBe(0);
        expect(result.overpaymentCents).toBe(2999);
    });

    it("never produces a negative amount owed", () => {
        // Credited for more than the invoice ever charged: a floor, not a
        // negative due.
        const result = settlementFor({
            grossCents: 1000,
            creditedCents: 1500,
            receivedCents: 0,
        });

        expect(result.dueCents).toBe(0);
        expect(result.outstandingCents).toBe(0);
    });

    it("refuses fractional cents rather than rounding them away", () => {
        expect(() =>
            settlementFor({
                grossCents: 29.99,
                creditedCents: 0,
                receivedCents: 0,
            }),
        ).toThrow(/whole cents/);
    });

    it("refuses more having gone out than ever came in", () => {
        expect(() =>
            settlementFor({
                grossCents: 1000,
                creditedCents: 0,
                receivedCents: -1,
            }),
        ).toThrow();
    });
});

describe("receivedFrom", () => {
    it("counts only what settled", () => {
        expect(
            receivedFrom([
                { kind: "charge", status: "pending", amountCents: 2999 },
                { kind: "charge", status: "failed", amountCents: 2999 },
                { kind: "charge", status: "processing", amountCents: 2999 },
                { kind: "charge", status: "succeeded", amountCents: 1000 },
            ]),
        ).toBe(1000);
    });

    it("subtracts refunds", () => {
        expect(
            receivedFrom([
                { kind: "charge", status: "succeeded", amountCents: 2999 },
                { kind: "refund", status: "succeeded", amountCents: 1000 },
            ]),
        ).toBe(1999);
    });

    it("a fully refunded charge nets to zero", () => {
        // The charge is marked `refunded` and the refund is its own row; both
        // are counted, and they cancel.
        expect(
            receivedFrom([
                { kind: "charge", status: "refunded", amountCents: 2999 },
                { kind: "refund", status: "succeeded", amountCents: 2999 },
            ]),
        ).toBe(0);
    });

    it("two part payments add up", () => {
        expect(
            receivedFrom([
                { kind: "charge", status: "succeeded", amountCents: 1000 },
                { kind: "charge", status: "succeeded", amountCents: 1999 },
            ]),
        ).toBe(2999);
    });

    it("never goes below zero", () => {
        expect(
            receivedFrom([
                { kind: "charge", status: "succeeded", amountCents: 1000 },
                { kind: "refund", status: "succeeded", amountCents: 5000 },
            ]),
        ).toBe(0);
    });
});

/**
 * PayPal sends money as a decimal string. `Number("19.99") * 100` is
 * 1998.9999999999998, and `Math.round` only hides that until a value lands on
 * the other side of a half — so the parse never leaves the integers.
 */
describe("fromDecimalString", () => {
    it("reads a provider's two-decimal amount exactly", () => {
        expect(fromDecimalString("19.99")).toBe(1999);
        expect(fromDecimalString("0.01")).toBe(1);
        expect(fromDecimalString("1.00")).toBe(100);
        expect(fromDecimalString("1234.56")).toBe(123456);
    });

    it("accepts a whole amount and a single decimal place", () => {
        expect(fromDecimalString("5")).toBe(500);
        expect(fromDecimalString("5.5")).toBe(550);
    });

    it("keeps the sign", () => {
        expect(fromDecimalString("-19.99")).toBe(-1999);
    });

    it("refuses what is not one plain amount", () => {
        // Deliberately *not* parseAmount: that one reads German and would
        // take "1.000" for a thousand euro.
        expect(fromDecimalString("1.000")).toBeNull();
        expect(fromDecimalString("19,99")).toBeNull();
        expect(fromDecimalString("19.99 EUR")).toBeNull();
        expect(fromDecimalString("")).toBeNull();
        expect(fromDecimalString("abc")).toBeNull();
    });

    it("round-trips with toDecimalString", () => {
        for (const cents of [0, 1, 99, 100, 1999, 123456, -1999]) {
            expect(fromDecimalString(toDecimalString(cents))).toBe(cents);
        }
    });

    it("gets the cases a float would get wrong", () => {
        // Every one of these is a value where `Number(x) * 100` is not an
        // integer in IEEE 754.
        for (const [text, cents] of [
            ["19.99", 1999],
            ["29.99", 2999],
            ["1.07", 107],
            ["1.11", 111],
            ["8.87", 887],
            ["23.95", 2395],
        ] as const) {
            expect(fromDecimalString(text)).toBe(cents);
        }
    });
});
