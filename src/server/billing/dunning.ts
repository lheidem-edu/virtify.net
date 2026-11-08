import type { DunningLevel } from "@/db/schema";
import type { BillingPolicy } from "@/server/settings";

/**
 * When an unpaid invoice is chased, and when a card is tried again.
 *
 * Pure: a due date, an instant and the policy in, a list of rungs out. No
 * database, no clock it was not handed — so the ninety-day simulation can
 * walk a fake clock through it and assert the exact day each thing happens.
 *
 * Both ladders are reckoned from the invoice's **due date**, which is the
 * only date the customer and § 286 BGB agree on. The run then claims each
 * rung in the database before acting on it; nothing here knows about that,
 * and nothing here decides anything twice — it only says which rungs have
 * been reached.
 */

const DAY_MS = 86_400_000;

/** The order severity actually goes in, whatever the numbers say. */
export const DUNNING_ORDER: readonly DunningLevel[] = [
    "reminder",
    "mahnung",
    "suspend",
    "terminate",
];

export const DUNNING_LABEL: Record<DunningLevel, string> = {
    reminder: "Zahlungserinnerung",
    mahnung: "Mahnung",
    suspend: "Leistungen gesperrt",
    terminate: "Abo beendet",
};

export type DunningRung = {
    level: DunningLevel;
    /** Days after the due date. */
    days: number;
    /** The instant the rung becomes due. */
    at: Date;
};

function configuredDays(policy: BillingPolicy): Record<DunningLevel, number> {
    return {
        reminder: policy.dunningReminderDays,
        mahnung: policy.dunningMahnungDays,
        suspend: policy.dunningSuspendDays,
        terminate: policy.dunningTerminateDays,
    };
}

/**
 * The four rungs, in severity order, with their days made non-decreasing.
 *
 * The clamp is not pedantry. The four numbers are four separate fields in a
 * form, and somebody will one day set the Mahnung to 10 days and the
 * suspension to 5 — at which point an invoice would be suspended before its
 * customer had ever been written to. Taking the running maximum means a
 * misconfiguration can make a rung happen at the same time as the one
 * before it, but never before it.
 */
export function dunningLadder(
    dueAt: Date,
    policy: BillingPolicy,
): DunningRung[] {
    const days = configuredDays(policy);
    const rungs: DunningRung[] = [];
    let floor = 0;

    for (const level of DUNNING_ORDER) {
        const value = Math.max(Math.trunc(days[level]), floor);

        floor = value;

        rungs.push({
            level,
            days: value,
            at: new Date(dueAt.getTime() + value * DAY_MS),
        });
    }

    return rungs;
}

/**
 * The rungs that have come due by `now`, earliest first.
 *
 * All of them, not just the latest: an invoice that nobody chased for a
 * fortnight — a worker that was down, a run that failed — owes its customer
 * the reminder and the Mahnung before it owes them a suspension, and the
 * run claims each one in turn. Skipping to the newest rung would suspend a
 * service belonging to somebody who was never written to.
 */
export function dunningDue(
    dueAt: Date,
    now: Date,
    policy: BillingPolicy,
): DunningRung[] {
    return dunningLadder(dueAt, policy).filter(
        (rung) => rung.at.getTime() <= now.getTime(),
    );
}

export type CollectionRung = {
    /** Days after the due date. */
    offsetDays: number;
    at: Date;
};

/**
 * The retry ladder for collecting off a stored payment method: d+0, d+3,
 * d+7 by default.
 *
 * Sorted and de-duplicated, because `offset_days` is half of the unique key
 * that makes each rung happen once and two rungs on the same day would be
 * one rung that silently never fired.
 */
export function collectionLadder(
    dueAt: Date,
    policy: BillingPolicy,
): CollectionRung[] {
    const offsets = [
        ...new Set(
            policy.collectionRetryDays
                .map((value) => Math.max(Math.trunc(value), 0))
                .filter((value) => Number.isSafeInteger(value)),
        ),
    ].sort((a, b) => a - b);

    return offsets.map((offsetDays) => ({
        offsetDays,
        at: new Date(dueAt.getTime() + offsetDays * DAY_MS),
    }));
}

/** The rungs of the collection ladder that have come due by `now`. */
export function collectionDue(
    dueAt: Date,
    now: Date,
    policy: BillingPolicy,
): CollectionRung[] {
    return collectionLadder(dueAt, policy).filter(
        (rung) => rung.at.getTime() <= now.getTime(),
    );
}

/**
 * The wording of the dunning notice. German, because the customer reads it;
 * `§ 286 Abs. 3 BGB` is why the Mahnung names a date rather than asking.
 */
export function dunningMessage(input: {
    level: DunningLevel;
    invoiceNumber: string;
    amountCents: number;
    formatted: string;
    dueAt: Date;
}): { subject: string; lines: string[] } {
    const day = new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "Europe/Berlin",
    }).format(input.dueAt);

    switch (input.level) {
        case "reminder":
            return {
                subject: `Zahlungserinnerung zu ${input.invoiceNumber}`,
                lines: [
                    `Die Rechnung ${input.invoiceNumber} über ${input.formatted} war am ${day} fällig und ist bei uns noch nicht eingegangen.`,
                    "Falls sich das überschnitten hat, betrachte diese Nachricht bitte als gegenstandslos.",
                ],
            };
        case "mahnung":
            return {
                subject: `Mahnung zu ${input.invoiceNumber}`,
                lines: [
                    `Die Rechnung ${input.invoiceNumber} über ${input.formatted} war am ${day} fällig und ist weiterhin offen.`,
                    "Bitte gleiche den Betrag aus. Andernfalls müssen wir die Leistungen vorübergehend sperren.",
                ],
            };
        case "suspend":
            return {
                subject: `Leistungen gesperrt — ${input.invoiceNumber}`,
                lines: [
                    `Die Rechnung ${input.invoiceNumber} über ${input.formatted} ist seit dem ${day} offen; die zugehörigen Leistungen sind jetzt gesperrt.`,
                    "Sobald die Zahlung eingegangen ist, werden sie automatisch wieder freigeschaltet.",
                ],
            };
        default:
            return {
                subject: `Abo beendet — ${input.invoiceNumber}`,
                lines: [
                    `Die Rechnung ${input.invoiceNumber} über ${input.formatted} ist seit dem ${day} offen. Das zugehörige Abo ist damit beendet und die Leistungen werden abgebaut.`,
                    "Der offene Betrag bleibt bestehen.",
                ],
            };
    }
}
