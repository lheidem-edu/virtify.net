import type { SubscriptionStatus } from "@/db/schema";

/**
 * The subscription state machine, and nothing else.
 *
 * Pure: a pair of statuses in, a verdict out. No database, no clock, no
 * React. Everything that moves a subscription goes through
 * `assertTransition` first, and an illegal move throws rather than being
 * quietly written — a subscription that went from `ended` back to `active`
 * because some admin action forgot to check would start billing a customer
 * whose services were terminated weeks ago.
 *
 *     trialing → active → past_due → (active | paused | cancelled) → ended
 *
 * `cancelled` is not the end: it means *will not renew*, and the Abo is
 * still running to the end of the period the customer paid for. Undoing a
 * cancellation before that day is therefore a legal move back to `active`,
 * and it is the one people actually use.
 */

export type { SubscriptionStatus };

/**
 * What each status may become. Read it as "from → the set of to".
 *
 * Written out rather than derived from rules, because the rules would be
 * four special cases in a trench coat and this is the thing a reviewer has
 * to be able to check at a glance.
 */
export const SUBSCRIPTION_TRANSITIONS: Record<
    SubscriptionStatus,
    readonly SubscriptionStatus[]
> = {
    /** The free days. They end in a first charge, or they end. */
    trialing: ["active", "past_due", "cancelled", "ended"],
    active: ["past_due", "paused", "cancelled", "ended"],
    /** An invoice for it is overdue. It comes back when the money does. */
    past_due: ["active", "paused", "cancelled", "ended"],
    paused: ["active", "cancelled", "ended"],
    /** Running out its paid period. Reinstating it is the common undo. */
    cancelled: ["active", "ended"],
    /** Over. Nothing leaves here — a new Abo is a new row. */
    ended: [],
};

/** The ones a renewal is raised for. Paused and ended are not billed. */
export const BILLABLE_STATUSES: readonly SubscriptionStatus[] = [
    "trialing",
    "active",
    "past_due",
    "cancelled",
];

/** The ones that still count as running, for a list the customer reads. */
export const LIVE_STATUSES: readonly SubscriptionStatus[] = [
    "trialing",
    "active",
    "past_due",
    "paused",
    "cancelled",
];

export function isLive(status: SubscriptionStatus): boolean {
    return LIVE_STATUSES.includes(status);
}

/**
 * Whether `from` may become `to`.
 *
 * A status becoming itself is **not** a transition: it is a caller that did
 * not check whether it had anything to do, and letting it through would put
 * a "von active nach active" line in the customer's own timeline. Callers
 * compare first and skip.
 */
export function canTransition(
    from: SubscriptionStatus,
    to: SubscriptionStatus,
): boolean {
    if (from === to) {
        return false;
    }

    return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

export class SubscriptionStateError extends Error {
    constructor(
        readonly from: SubscriptionStatus,
        readonly to: SubscriptionStatus,
    ) {
        super(
            from === to
                ? `Das Abo ist bereits „${from}“.`
                : `Ein Abo kann nicht von „${from}“ nach „${to}“ wechseln.`,
        );
        this.name = "SubscriptionStateError";
    }
}

export function assertTransition(
    from: SubscriptionStatus,
    to: SubscriptionStatus,
): void {
    if (!canTransition(from, to)) {
        throw new SubscriptionStateError(from, to);
    }
}

/**
 * What the services under a subscription become when it reaches a status.
 * `null` means "leave them alone" — most transitions do not touch them.
 *
 * The services *follow*; they never lead. A service is suspended because
 * the Abo is paused or dunning said so, and it is terminated because the
 * Abo ended. Nothing here ever creates one.
 */
export type ServiceFollow = "active" | "suspended" | "terminated" | null;

export function servicesFollow(to: SubscriptionStatus): ServiceFollow {
    switch (to) {
        case "ended":
            return "terminated";
        case "paused":
            return "suspended";
        case "active":
            // Coming back from paused or past_due. Only a service that was
            // suspended is woken; one still `pending` stays pending, because
            // nobody has set it up yet.
            return "active";
        default:
            // `trialing`, `past_due` and `cancelled` all leave the service
            // running: the customer is inside a period they have paid for,
            // or inside the grace dunning gives them. Suspension at +14 days
            // is dunning's decision, not the status's.
            return null;
    }
}
