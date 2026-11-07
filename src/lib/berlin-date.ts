/**
 * Dates as the operator reads them.
 *
 * Everything is stored in UTC (CLAUDE.md rule 9), but every date the operator
 * types into the admin area — a coupon's validity, the day a tax switch takes
 * effect — is a day on the *Berlin* calendar. Midnight UTC is 01:00 or 02:00
 * here, so reading one as a UTC instant is an hour or two of the wrong day at
 * each end: a coupon refused for the whole day it was meant to cover, or a
 * tax switch that catches the invoices of the evening before.
 */

/** The Berlin UTC offset at an *instant* — `+01:00` or `+02:00`. */
function offsetAt(instant: Date): string {
    const name = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Berlin",
        timeZoneName: "longOffset",
    })
        .formatToParts(instant)
        .find((part) => part.type === "timeZoneName")?.value;

    // "GMT+01:00" → "+01:00"; "GMT" itself would mean no offset at all.
    const offset = name?.replace("GMT", "") ?? "";

    return offset === "" ? "Z" : offset;
}

/**
 * `+01:00` or `+02:00` for a `YYYY-MM-DD`, whichever Berlin was on that day.
 *
 * Sampled at noon, which is the offset the day is *mostly* on. On the two
 * days the clocks move that is not the offset at midnight, so
 * `berlinInstant()` resolves its own rather than using this one.
 */
export function berlinOffset(day: string): string {
    const noon = new Date(`${day}T12:00:00.000Z`);

    return Number.isNaN(noon.getTime()) ? "Z" : offsetAt(noon);
}

/**
 * The first — or, with `end`, the last — instant of a `YYYY-MM-DD` in Berlin.
 * Null for anything that is not a date.
 *
 * The offset is resolved at the candidate instant and then re-resolved once,
 * rather than sampled at noon. On the last Sunday of March noon is already
 * CEST while 00:00 local is still CET, so applying the noon offset to
 * midnight landed an hour *before* the day began — 23:00 on the evening
 * before, which is precisely the "tax switch that catches the invoices of
 * the evening before" this module exists to prevent. The last Sunday of
 * October is the mirror image, losing the day's first hour.
 *
 * One re-resolution is enough: a transition moves the wall clock by an hour,
 * and the second guess is already on the correct side of it.
 */
export function berlinInstant(day: string, end = false): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return null;
    }

    const wall = `${day}T${end ? "23:59:59.999" : "00:00:00.000"}`;
    let parsed = new Date(`${wall}${berlinOffset(day)}`);

    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    const corrected = new Date(`${wall}${offsetAt(parsed)}`);

    if (!Number.isNaN(corrected.getTime())) {
        parsed = corrected;
    }

    return parsed;
}

/** The calendar year an instant falls in, read in Berlin rather than in UTC. */
export function berlinYear(at: Date): number {
    return Number(
        new Intl.DateTimeFormat("en-GB", {
            year: "numeric",
            timeZone: "Europe/Berlin",
        }).format(at),
    );
}
