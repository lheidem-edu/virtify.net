import { describe, expect, it } from "vitest";
import {
    collectionDue,
    collectionLadder,
    DUNNING_ORDER,
    dunningDue,
    dunningLadder,
    dunningMessage,
} from "@/server/billing/dunning";
import { defaultSettings } from "@/server/settings";

/**
 * The two ladders: when a card is tried again, and when a customer is
 * chased.
 *
 * Pure, so every case names the day it expects. The dates matter more here
 * than almost anywhere else in the project — a rung that fires a day early
 * suspends a server somebody has paid for.
 */

const POLICY = defaultSettings.billing;
const DUE = new Date("2026-11-10T00:00:00.000Z");

function day(at: Date): string {
    return at.toISOString().slice(0, 10);
}

describe("the dunning ladder", () => {
    it("falls on +3, +10, +14 and +30 after the due date", () => {
        const ladder = dunningLadder(DUE, POLICY);

        expect(ladder.map((rung) => [rung.level, day(rung.at)])).toEqual([
            ["reminder", "2026-11-13"],
            ["mahnung", "2026-11-20"],
            ["suspend", "2026-11-24"],
            ["terminate", "2026-12-10"],
        ]);
    });

    it("reaches no rung on the due date itself", () => {
        expect(dunningDue(DUE, DUE, POLICY)).toEqual([]);
    });

    it("reaches one rung at a time", () => {
        const on = (iso: string) =>
            dunningDue(DUE, new Date(iso), POLICY).map((rung) => rung.level);

        expect(on("2026-11-12T23:00:00.000Z")).toEqual([]);
        expect(on("2026-11-13T00:00:00.000Z")).toEqual(["reminder"]);
        expect(on("2026-11-19T23:00:00.000Z")).toEqual(["reminder"]);
        expect(on("2026-11-20T00:00:00.000Z")).toEqual(["reminder", "mahnung"]);
    });

    it("hands back every rung a late run missed, in order", () => {
        // A worker that was down for three weeks. The customer is owed the
        // reminder and the Mahnung before they are owed a suspension, and
        // the run claims each in turn — so this must not skip to the newest.
        const missed = dunningDue(DUE, new Date("2026-12-11"), POLICY);

        expect(missed.map((rung) => rung.level)).toEqual([...DUNNING_ORDER]);
    });

    it("never lets a misconfiguration suspend before it warns", () => {
        // Somebody sets the Mahnung to 10 days and the suspension to 5.
        const ladder = dunningLadder(DUE, {
            ...POLICY,
            dunningMahnungDays: 10,
            dunningSuspendDays: 5,
            dunningTerminateDays: 1,
        });

        expect(ladder.map((rung) => rung.days)).toEqual([3, 10, 10, 10]);
        // Severity order is kept whatever the numbers say.
        expect(ladder.map((rung) => rung.level)).toEqual([...DUNNING_ORDER]);
    });

    it("can be turned into same-day dunning, but not into back-to-front dunning", () => {
        const ladder = dunningLadder(DUE, {
            ...POLICY,
            dunningReminderDays: 0,
            dunningMahnungDays: 0,
            dunningSuspendDays: 0,
            dunningTerminateDays: 0,
        });

        expect(ladder.every((rung) => rung.days === 0)).toBe(true);
    });
});

describe("the collection ladder", () => {
    it("is d+0, d+3, d+7 by default", () => {
        expect(
            collectionLadder(DUE, POLICY).map((rung) => [
                rung.offsetDays,
                day(rung.at),
            ]),
        ).toEqual([
            [0, "2026-11-10"],
            [3, "2026-11-13"],
            [7, "2026-11-17"],
        ]);
    });

    it("tries on the due date itself — d+0 means today", () => {
        expect(
            collectionDue(DUE, DUE, POLICY).map((r) => r.offsetDays),
        ).toEqual([0]);
    });

    it("adds a rung only when its day has come", () => {
        const on = (iso: string) =>
            collectionDue(DUE, new Date(iso), POLICY).map(
                (rung) => rung.offsetDays,
            );

        expect(on("2026-11-09")).toEqual([]);
        expect(on("2026-11-12")).toEqual([0]);
        expect(on("2026-11-13")).toEqual([0, 3]);
        expect(on("2026-11-30")).toEqual([0, 3, 7]);
    });

    it("de-duplicates and sorts, because the offset is half a unique key", () => {
        // Two rungs on the same day would be one rung that silently never
        // fired: the second insert loses to `(invoice_id, offset_days)`.
        const ladder = collectionLadder(DUE, {
            ...POLICY,
            collectionRetryDays: [7, 0, 3, 3, -4],
        });

        expect(ladder.map((rung) => rung.offsetDays)).toEqual([0, 3, 7]);
    });

    it("can be a single attempt", () => {
        expect(
            collectionLadder(DUE, {
                ...POLICY,
                collectionRetryDays: [0],
            }),
        ).toHaveLength(1);
    });
});

describe("what the customer is told", () => {
    it("names the invoice, the amount and the date it was due", () => {
        const message = dunningMessage({
            level: "mahnung",
            invoiceNumber: "RE-2026-0042",
            amountCents: 1999,
            formatted: "19,99 €",
            dueAt: new Date("2026-11-10T00:00:00.000Z"),
        });

        expect(message.subject).toBe("Mahnung zu RE-2026-0042");
        expect(message.lines.join(" ")).toContain("RE-2026-0042");
        expect(message.lines.join(" ")).toContain("19,99 €");
        expect(message.lines.join(" ")).toContain("10.11.2026");
    });

    it("says something different at every rung", () => {
        const subjects = DUNNING_ORDER.map(
            (level) =>
                dunningMessage({
                    level,
                    invoiceNumber: "RE-2026-0042",
                    amountCents: 1999,
                    formatted: "19,99 €",
                    dueAt: new Date("2026-11-10T00:00:00.000Z"),
                }).subject,
        );

        expect(new Set(subjects).size).toBe(DUNNING_ORDER.length);
    });

    it("tells a suspended customer that paying brings it back", () => {
        const message = dunningMessage({
            level: "suspend",
            invoiceNumber: "RE-2026-0042",
            amountCents: 1999,
            formatted: "19,99 €",
            dueAt: new Date("2026-11-10T00:00:00.000Z"),
        });

        expect(message.lines.join(" ")).toMatch(/automatisch wieder/);
    });
});
