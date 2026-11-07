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

/** `+01:00` or `+02:00` for a `YYYY-MM-DD`, whichever Berlin was on that day. */
export function berlinOffset(day: string): string {
    const noon = new Date(`${day}T12:00:00.000Z`);

    if (Number.isNaN(noon.getTime())) {
        return "Z";
    }

    const name = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Berlin",
        timeZoneName: "longOffset",
    })
        .formatToParts(noon)
        .find((part) => part.type === "timeZoneName")?.value;

    // "GMT+01:00" → "+01:00"; "GMT" itself would mean no offset at all.
    const offset = name?.replace("GMT", "") ?? "";

    return offset === "" ? "Z" : offset;
}

/**
 * The first — or, with `end`, the last — instant of a `YYYY-MM-DD` in Berlin.
 * Null for anything that is not a date.
 */
export function berlinInstant(day: string, end = false): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return null;
    }

    const parsed = new Date(
        `${day}T${end ? "23:59:59.999" : "00:00:00.000"}${berlinOffset(day)}`,
    );

    return Number.isNaN(parsed.getTime()) ? null : parsed;
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
