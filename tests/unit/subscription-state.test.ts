import { describe, expect, it } from "vitest";
import type { SubscriptionStatus } from "@/db/schema";
import {
    assertTransition,
    BILLABLE_STATUSES,
    canTransition,
    isLive,
    LIVE_STATUSES,
    SUBSCRIPTION_TRANSITIONS,
    SubscriptionStateError,
    servicesFollow,
} from "@/server/subscriptions/state";

/**
 * The state machine, stated as the thing a reviewer actually has to check:
 * which moves are legal, which are not, and what the services do.
 *
 * It is pure, so every case here is a pair of strings. That is the point —
 * the rule should be checkable without a database, a clock or a gateway.
 */

const ALL: SubscriptionStatus[] = [
    "trialing",
    "active",
    "past_due",
    "paused",
    "cancelled",
    "ended",
];

describe("the subscription state machine", () => {
    it("runs the path the build plan describes", () => {
        // trialing → active → past_due → (active | paused | cancelled) → ended
        expect(canTransition("trialing", "active")).toBe(true);
        expect(canTransition("active", "past_due")).toBe(true);
        expect(canTransition("past_due", "active")).toBe(true);
        expect(canTransition("past_due", "paused")).toBe(true);
        expect(canTransition("past_due", "cancelled")).toBe(true);
        expect(canTransition("cancelled", "ended")).toBe(true);
    });

    it("lets a cancellation be taken back while the period runs", () => {
        // `cancelled` means "will not renew", not "over". Undoing it before
        // the period ends is the move people actually make.
        expect(canTransition("cancelled", "active")).toBe(true);
    });

    it("never leaves `ended`", () => {
        expect(SUBSCRIPTION_TRANSITIONS.ended).toEqual([]);

        for (const to of ALL) {
            expect(canTransition("ended", to)).toBe(false);
        }
    });

    it("refuses a status becoming itself", () => {
        for (const status of ALL) {
            expect(canTransition(status, status)).toBe(false);
        }
    });

    it("refuses the moves that would bill or strand a customer", () => {
        // A paused Abo is not overdue: nothing has been invoiced for it.
        expect(canTransition("paused", "past_due")).toBe(false);
        // Nothing goes back into a trial once it has been left.
        expect(canTransition("active", "trialing")).toBe(false);
        expect(canTransition("past_due", "trialing")).toBe(false);
        expect(canTransition("cancelled", "paused")).toBe(false);
        expect(canTransition("cancelled", "past_due")).toBe(false);
        expect(canTransition("cancelled", "trialing")).toBe(false);
    });

    it("throws rather than returning false, with the pair in the message", () => {
        expect(() => assertTransition("ended", "active")).toThrow(
            SubscriptionStateError,
        );
        expect(() => assertTransition("ended", "active")).toThrow(
            /von „ended“ nach „active“/,
        );
        expect(() => assertTransition("active", "active")).toThrow(
            /bereits „active“/,
        );
        expect(() => assertTransition("active", "past_due")).not.toThrow();
    });

    it("names every status in the table, so a new one cannot be forgotten", () => {
        expect(Object.keys(SUBSCRIPTION_TRANSITIONS).sort()).toEqual(
            [...ALL].sort(),
        );

        for (const [from, targets] of Object.entries(
            SUBSCRIPTION_TRANSITIONS,
        )) {
            for (const to of targets) {
                expect(ALL, `${from} → ${to} is not a status`).toContain(to);
            }
        }
    });
});

describe("what gets billed and what counts as running", () => {
    it("bills everything that is still owed for, and nothing else", () => {
        // A paused Abo raises no invoice; an ended one obviously does not.
        expect([...BILLABLE_STATUSES].sort()).toEqual(
            ["active", "cancelled", "past_due", "trialing"].sort(),
        );
        expect(BILLABLE_STATUSES).not.toContain("paused");
        expect(BILLABLE_STATUSES).not.toContain("ended");
    });

    it("counts everything but `ended` as live", () => {
        for (const status of ALL) {
            expect(isLive(status)).toBe(status !== "ended");
        }

        expect(LIVE_STATUSES).not.toContain("ended");
    });
});

describe("what the services do", () => {
    it("terminates on `ended` and suspends on `paused`", () => {
        expect(servicesFollow("ended")).toBe("terminated");
        expect(servicesFollow("paused")).toBe("suspended");
    });

    it("wakes them on `active`", () => {
        expect(servicesFollow("active")).toBe("active");
    });

    it("leaves a past_due service running — that grace is what dunning is", () => {
        // Suspension at the dunning rung is a decision of its own, made by
        // `runDunning`. If `past_due` suspended on its own, a customer would
        // lose their server the morning after the due date.
        expect(servicesFollow("past_due")).toBeNull();
        expect(servicesFollow("trialing")).toBeNull();
        expect(servicesFollow("cancelled")).toBeNull();
    });
});
