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

/** The wall-clock fields an instant shows on a Berlin clock. */
export type BerlinParts = {
    year: number;
    /** 1–12, not the 0–11 `Date` uses. */
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
};

const PARTS_FORMAT = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
});

export function berlinParts(at: Date): BerlinParts {
    const parts = Object.fromEntries(
        PARTS_FORMAT.formatToParts(at).map((part) => [part.type, part.value]),
    );

    return {
        year: Number(parts.year),
        month: Number(parts.month),
        // Intl writes midnight as "24" in some ICU versions; 24:00 of one day
        // is 00:00 of the next, and the day part already names the next one.
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        second: Number(parts.second),
        millisecond: at.getMilliseconds(),
    };
}

/** The `YYYY-MM-DD` an instant falls on in Berlin. */
export function berlinDay(at: Date): string {
    const { year, month, day } = berlinParts(at);

    return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

/** How many days a month has — the reason a billing anchor stops at 28. */
export function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The instant a Berlin wall clock reads these fields at.
 *
 * The offset is resolved at the candidate instant and re-resolved once, for
 * the reason `berlinInstant()` gives: on the two days the clocks move, a
 * guessed offset is an hour out, and a billing period that starts an hour
 * before it should is a period that overlaps the one before it.
 */
export function fromBerlinParts(parts: BerlinParts): Date {
    const wall =
        `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
        `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
        `.${pad(parts.millisecond, 3)}`;

    const day = wall.slice(0, 10);
    let parsed = new Date(`${wall}${berlinOffset(day)}`);

    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Not a date: ${wall}`);
    }

    const corrected = new Date(`${wall}${offsetAt(parsed)}`);

    if (!Number.isNaN(corrected.getTime())) {
        parsed = corrected;
    }

    return parsed;
}

/**
 * `at` plus whole months, on the Berlin calendar, with the day clamped to
 * the length of the month it lands in — 31 January plus one month is 28
 * February, not 3 March.
 *
 * Keeping the wall-clock time rather than adding milliseconds is what makes
 * a period that starts at 10:00 still start at 10:00 after the clocks move.
 */
export function addBerlinMonths(at: Date, months: number): Date {
    const parts = berlinParts(at);
    const zeroBased = parts.month - 1 + months;
    const year = parts.year + Math.floor(zeroBased / 12);
    const month = (((zeroBased % 12) + 12) % 12) + 1;

    return fromBerlinParts({
        ...parts,
        year,
        month,
        day: Math.min(parts.day, daysInMonth(year, month)),
    });
}

/**
 * Whole days from `from` to `to`, counted as Berlin calendar days rather
 * than as elapsed time — so the two days the clocks move are one day each,
 * and a proration does not gain or lose an hour's worth of cents.
 */
export function berlinDaysBetween(from: Date, to: Date): number {
    const a = berlinParts(from);
    const b = berlinParts(to);

    const start = Date.UTC(a.year, a.month - 1, a.day);
    const end = Date.UTC(b.year, b.month - 1, b.day);

    return Math.round((end - start) / 86_400_000);
}
