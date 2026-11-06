/**
 * Money is integer minor units — cents for EUR. Nothing in this file ever
 * produces a fractional amount, because a float cent is a rounding bug waiting
 * for a quarterly invoice.
 */

export type Currency = "EUR";

export const DEFAULT_CURRENCY: Currency = "EUR";

/** Minor units per major unit. Exponent 2 for every currency we bill in. */
const MINOR_UNITS: Record<Currency, number> = { EUR: 100 };

export function minorUnits(currency: Currency = DEFAULT_CURRENCY): number {
    return MINOR_UNITS[currency];
}

function assertInteger(cents: number, what = "amount"): void {
    if (!Number.isSafeInteger(cents)) {
        throw new Error(`${what} must be an integer number of cents: ${cents}`);
    }
}

/**
 * Half away from zero, not JavaScript's `Math.round`. `Math.round(-0.5)` is
 * `-0`, so a credit note line would not be the exact negation of the invoice
 * line it reverses. Rounding away from zero makes `round(-x) === -round(x)`
 * hold, which is the property a correction depends on.
 */
export function roundHalfUp(value: number): number {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot round ${value}`);
    }

    return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function add(...amounts: number[]): number {
    for (const amount of amounts) {
        assertInteger(amount);
    }

    return amounts.reduce((sum, amount) => sum + amount, 0);
}

export function subtract(minuend: number, ...subtrahends: number[]): number {
    return add(minuend, ...subtrahends.map((value) => -value));
}

/** Multiply an amount by a quantity or a rate, rounded to whole cents. */
export function multiply(cents: number, factor: number): number {
    assertInteger(cents);

    if (!Number.isFinite(factor)) {
        throw new Error(`Cannot multiply by ${factor}`);
    }

    return roundHalfUp(cents * factor);
}

/** A percentage of an amount, e.g. `percent(10_00, 19)` → `190`. */
export function percent(cents: number, rate: number): number {
    return multiply(cents, rate / 100);
}

export function negate(cents: number): number {
    assertInteger(cents);

    return -cents;
}

export function abs(cents: number): number {
    assertInteger(cents);

    return Math.abs(cents);
}

/**
 * Split an amount across weights so the parts add up to exactly the amount.
 * The largest remainders get the leftover cents, which is the allocation rule
 * that keeps a prorated discount from being a cent short of its total.
 */
export function allocate(cents: number, weights: number[]): number[] {
    assertInteger(cents);

    if (weights.length === 0) {
        throw new Error("Cannot allocate across no weights");
    }

    if (weights.some((weight) => weight < 0 || !Number.isFinite(weight))) {
        throw new Error("Allocation weights must be finite and non-negative");
    }

    const total = weights.reduce((sum, weight) => sum + weight, 0);

    if (total === 0) {
        // Nothing to weigh by: share it out as evenly as possible instead.
        return allocate(
            cents,
            weights.map(() => 1),
        );
    }

    const sign = cents < 0 ? -1 : 1;
    const magnitude = Math.abs(cents);

    const exact = weights.map((weight) => (magnitude * weight) / total);
    const floors = exact.map(Math.floor);
    let remainder = magnitude - floors.reduce((sum, part) => sum + part, 0);

    const order = exact
        .map((value, index) => ({ index, fraction: value - floors[index] }))
        .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

    const parts = [...floors];

    for (const { index } of order) {
        if (remainder <= 0) {
            break;
        }

        parts[index] += 1;
        remainder -= 1;
    }

    return parts.map((part) => part * sign);
}

/** Split an amount into `count` parts that add up to exactly the amount. */
export function split(cents: number, count: number): number[] {
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error(`Cannot split into ${count} parts`);
    }

    return allocate(
        cents,
        Array.from({ length: count }, () => 1),
    );
}

/**
 * Prorate an amount over the part of a period that is actually used. Both
 * bounds count in days, so a 30-day month billed from day 16 charges 15 days.
 */
export function prorate(
    cents: number,
    usedDays: number,
    periodDays: number,
): number {
    if (periodDays <= 0) {
        throw new Error(`A billing period cannot be ${periodDays} days long`);
    }

    const used = Math.min(Math.max(usedDays, 0), periodDays);

    return multiply(cents, used / periodDays);
}

const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(currency: Currency, locale: string): Intl.NumberFormat {
    const key = `${locale}:${currency}`;
    let cached = FORMATTERS.get(key);

    if (!cached) {
        cached = new Intl.NumberFormat(locale, { style: "currency", currency });
        FORMATTERS.set(key, cached);
    }

    return cached;
}

export function format(
    cents: number,
    currency: Currency = DEFAULT_CURRENCY,
    locale = "de-DE",
): string {
    assertInteger(cents);

    return formatter(currency, locale).format(cents / minorUnits(currency));
}

/** Cents as a bare decimal string, for XML and CSV where no symbol belongs. */
export function toDecimalString(
    cents: number,
    currency: Currency = DEFAULT_CURRENCY,
): string {
    assertInteger(cents);

    const unit = minorUnits(currency);
    const sign = cents < 0 ? "-" : "";
    const magnitude = Math.abs(cents);
    const major = Math.floor(magnitude / unit);
    const minor = String(magnitude % unit).padStart(
        String(unit).length - 1,
        "0",
    );

    return `${sign}${major}.${minor}`;
}

/**
 * Parse what somebody typed into a price field. German reading wins, because
 * that is the product's language: a lone comma is always the decimal
 * separator, and a lone dot followed by exactly three digits is a thousands
 * separator. When both appear, the one that comes last is the decimal one.
 *
 *   "19,99" → 1999      "19.99" → 1999      "1.000" → 100000
 *   "1.999,00" → 199900 "1,999.00" → 199900 "1,000" → 100
 *
 * Returns null for anything that is not a single amount, so a caller can say
 * so instead of quietly billing zero.
 */
export function parseAmount(
    input: string,
    currency: Currency = DEFAULT_CURRENCY,
): number | null {
    const trimmed = input.trim().replace(/[\s\u00a0€+]/g, "");

    if (trimmed === "") {
        return null;
    }

    // Accountants write a negative amount in parentheses.
    const bracketed = /^\(.*\)$/.test(trimmed);
    const negative = trimmed.startsWith("-") || bracketed;
    const body = bracketed ? trimmed.slice(1, -1) : trimmed.replace(/^-/, "");

    if (!/^[\d.,]+$/.test(body)) {
        return null;
    }

    const commas = (body.match(/,/g) ?? []).length;
    const dots = (body.match(/\./g) ?? []).length;

    let decimalSeparator: "," | "." | null = null;
    let groupSeparator: "," | "." | null = null;

    if (commas > 0 && dots > 0) {
        decimalSeparator =
            body.lastIndexOf(",") > body.lastIndexOf(".") ? "," : ".";
        groupSeparator = decimalSeparator === "," ? "." : ",";

        // The decimal separator can only appear once.
        if ((decimalSeparator === "," ? commas : dots) !== 1) {
            return null;
        }
    } else if (commas > 0) {
        if (commas !== 1) {
            return null;
        }

        decimalSeparator = ",";
    } else if (dots > 0) {
        const afterLastDot = body.length - body.lastIndexOf(".") - 1;
        const groupsThree = dots > 1 || (afterLastDot === 3 && body[0] !== ".");

        if (groupsThree) {
            groupSeparator = ".";
        } else {
            decimalSeparator = ".";
        }
    }

    let digits = body;

    if (groupSeparator) {
        const groups = digits.split(groupSeparator);
        const [first, ...rest] = groups;

        // A separator that does not group three digits is a typo, not a format.
        if (
            !/^\d{1,3}$/.test(first) ||
            rest.some((group, index) =>
                index === rest.length - 1 && decimalSeparator
                    ? !new RegExp(`^\\d{3}\\${decimalSeparator}\\d*$`).test(
                          group,
                      )
                    : !/^\d{3}$/.test(group),
            )
        ) {
            return null;
        }

        digits = groups.join("");
    }

    if (decimalSeparator === ",") {
        digits = digits.replace(",", ".");
    }

    if (!/^\d+(\.\d+)?$/.test(digits)) {
        return null;
    }

    const major = Number(digits);

    if (!Number.isFinite(major)) {
        return null;
    }

    const cents = roundHalfUp(major * minorUnits(currency));

    return negative ? -cents : cents;
}
