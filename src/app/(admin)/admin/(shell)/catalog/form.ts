import { parseAmount } from "@/lib/money";

/**
 * Reading the catalog forms. Form values arrive as strings; these turn them
 * into the shapes the zod schemas in `@/server/catalog/schema` take, and
 * nothing else — the rules stay in the schemas.
 *
 * Kept out of `actions.ts` because that file is `"use server"`, where every
 * export has to be an action.
 */

export function text(data: FormData, name: string): string {
    const raw = data.get(name);

    return typeof raw === "string" ? raw.trim() : "";
}

export function optional(data: FormData, name: string): string | undefined {
    const value = text(data, name);

    return value === "" ? undefined : value;
}

export function flag(data: FormData, name: string): boolean {
    return data.get(name) !== null;
}

export function integer(
    data: FormData,
    name: string,
    fallback: number,
): number {
    const parsed = Number.parseInt(text(data, name), 10);

    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A price field. German reading, via `parseAmount` — "19,99" is 1999 cents
 * and "1.999" is 199 900, which is what somebody typing a price here means.
 * An empty field is `null`, which is how the matrix says "not offered".
 */
export function cents(data: FormData, name: string): number | null {
    const value = text(data, name);

    return value === "" ? null : parseAmount(value);
}

/**
 * `<input type="date">` writes `YYYY-MM-DD`.
 *
 * `end` decides which instant of that day the operator meant. A coupon
 * "gültig bis 31.12." is valid *through* the 31st, so its validUntil is the
 * last instant of that day; read as midnight it would refuse the code for
 * the whole of the day it was supposed to cover. A validFrom is the first
 * instant of its day.
 *
 * Both in Europe/Berlin, because that is the calendar the operator is
 * looking at when they pick the date — midnight UTC is 01:00 or 02:00 here,
 * so a UTC boundary is an hour or two of the wrong day at each end.
 */
export function date(data: FormData, name: string, end = false): Date | null {
    const value = text(data, name);

    if (!value) {
        return null;
    }

    const parsed = new Date(
        `${value}T${end ? "23:59:59.999" : "00:00:00.000"}${berlinOffset(value)}`,
    );

    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `+01:00` or `+02:00` for a `YYYY-MM-DD`, whichever Berlin was on that day. */
function berlinOffset(day: string): string {
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
