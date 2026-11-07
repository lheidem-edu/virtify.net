import type { InvoiceStatus } from "@/db/schema";
import { add, subtract } from "@/lib/money";

/**
 * What a sum of money received does to an invoice. Pure: integer cents in,
 * integer cents out, no database, no clock, no gateway.
 *
 * It is a separate file from `apply.ts` for the same reason
 * `billing/invoices/totals.ts` is separate from the invoice service: this is
 * the arithmetic, and arithmetic is the part that has to be stated in
 * concrete numbers in a test. `apply.ts` is the transaction around it.
 *
 * **Nothing here recomputes what is owed.** `grossCents` is the figure
 * `calculateTotals()` froze onto the document at finalization and
 * `creditedCents` is what Rechnungskorrekturen have taken back off it; a
 * payment reads those two and never the lines. Phase 4 shipped a checkout
 * that showed 29,99 € and charged 25,99 € because a second arithmetic
 * existed, and a payment that computed its own idea of the total would be
 * that bug again with the money already gone.
 */

export type SettlementInput = {
    /** The document's own total, as frozen at finalization. */
    grossCents: number;
    /** What Rechnungskorrekturen have taken back off it. */
    creditedCents: number;
    /**
     * Everything successfully received against this invoice *after* the
     * payment being applied: charges less refunds. Can be zero (a refund took
     * everything back) but never negative — more cannot go back out than came
     * in, and the database refuses that too.
     */
    receivedCents: number;
};

export type Settlement = {
    /** What is owed after the corrections: `gross − credited`, floored at 0. */
    dueCents: number;
    /** What counts against the invoice. Never more than is owed. */
    paidCents: number;
    /** What is still open. */
    outstandingCents: number;
    /** Money beyond what was owed. Becomes credit, never a smaller invoice. */
    overpaymentCents: number;
    status: Extract<InvoiceStatus, "unpaid" | "partial" | "paid">;
};

export function settlementFor(input: SettlementInput): Settlement {
    const { grossCents, creditedCents, receivedCents } = input;

    for (const [name, value] of Object.entries(input)) {
        if (!Number.isSafeInteger(value)) {
            throw new Error(`${name} must be whole cents, got ${value}`);
        }
    }

    if (receivedCents < 0) {
        throw new Error("more cannot have gone back out than ever came in");
    }

    // A correction can take back more than the invoice charged only if
    // something has gone badly wrong upstream; the floor keeps this honest
    // rather than producing a negative amount owed.
    const dueCents = Math.max(subtract(grossCents, creditedCents), 0);

    const paidCents = Math.min(receivedCents, dueCents);
    const overpaymentCents = subtract(receivedCents, paidCents);
    const outstandingCents = subtract(dueCents, paidCents);

    // An invoice with nothing received is open, including the odd case of one
    // that owes nothing because it has been credited in full — that document
    // is `cancelled`, and it is not this function's job to say so.
    const status: Settlement["status"] =
        receivedCents <= 0
            ? "unpaid"
            : outstandingCents === 0
              ? "paid"
              : "partial";

    return {
        dueCents,
        paidCents,
        outstandingCents,
        overpaymentCents,
        status,
    };
}

/**
 * The running total of money received, from the transaction rows themselves.
 *
 * Charges count up, refunds count down, and only what actually settled counts
 * at all — a pending checkout and a failed card are not money. Summing the
 * rows rather than incrementing a column is what makes the figure
 * reconstructable: a row that was written twice would be visible, where a
 * column incremented twice is just wrong.
 */
export type SettledMovement = {
    kind: "charge" | "refund";
    status: string;
    amountCents: number;
};

export function receivedFrom(movements: readonly SettledMovement[]): number {
    const charges = movements
        .filter(
            (row) =>
                row.kind === "charge" &&
                (row.status === "succeeded" || row.status === "refunded"),
        )
        .map((row) => row.amountCents);

    const refunds = movements
        .filter((row) => row.kind === "refund" && row.status === "succeeded")
        .map((row) => row.amountCents);

    return Math.max(subtract(add(...charges), add(...refunds)), 0);
}
