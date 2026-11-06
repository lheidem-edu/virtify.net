import { monotonicFactory } from "ulid";
import { z } from "zod";

/**
 * Crockford's base32 alphabet without I, L, O and U, so an id cannot be
 * misread. A ULID is 26 of these characters: 10 encode the timestamp in
 * milliseconds, 16 are random.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = new RegExp(`^[0-7][${CROCKFORD}]{25}$`);

export const ULID_LENGTH = 26;

/**
 * A monotonic generator: two ids it mints in the same millisecond still sort
 * in the order they were created. The plain `ulid()` only guarantees that
 * across milliseconds, which would make the primary key a useless pagination
 * cursor for rows written in a tight loop.
 *
 * Each factory keeps its own state. Tests and backfills that want a fixed
 * timestamp need their own, because a generator only honours a seed that is
 * ahead of the last one it saw — asking the shared generator for a time in the
 * past silently returns the present instead.
 */
export function ulidFactory(): (seedTime?: number) => string {
    return monotonicFactory();
}

const nextUlid = ulidFactory();

/**
 * The id generator for everything that is stored. Deliberately takes no
 * timestamp: see `ulidFactory()`.
 */
export function ulid(): string {
    return nextUlid();
}

export function isUlid(value: unknown): value is string {
    return typeof value === "string" && ULID_PATTERN.test(value);
}

/** The millisecond the ULID was minted at, decoded from its first 10 chars. */
export function ulidTime(value: string): Date {
    if (!isUlid(value)) {
        throw new Error(`Not a ULID: ${value}`);
    }

    let ms = 0;

    for (const char of value.slice(0, 10)) {
        ms = ms * 32 + CROCKFORD.indexOf(char);
    }

    return new Date(ms);
}

/**
 * Ids are `<prefix>_<ULID>`, Stripe-style: self-describing in a log line or a
 * support request, and still sorted by creation time within a table, because
 * the prefix is the same for every row of it.
 */
export const ID_PREFIX = {
    user: "user",
    session: "session",
    account: "account",
    verification: "verification",
    twoFactor: "twofactor",
    staffUser: "staffuser",
    staffSession: "staffsession",
    staffAccount: "staffaccount",
    staffVerification: "staffverification",
    staffTwoFactor: "stafftwofactor",
    contract: "contract",
    offer: "offer",
    offerItem: "offeritem",
    invoice: "invoice",
    invoiceItem: "invoiceitem",
    payment: "payment",
    paymentMethod: "paymentmethod",
    legalDocument: "legaldocument",
    legalSection: "legalsection",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export function createId(prefix: IdPrefix): string {
    return `${prefix}_${ulid()}`;
}

export function idPrefixOf(id: string): string | null {
    const cut = id.lastIndexOf("_");

    return cut === -1 ? null : id.slice(0, cut);
}

export function isId(value: unknown, prefix?: IdPrefix): value is string {
    if (typeof value !== "string") {
        return false;
    }

    const cut = value.lastIndexOf("_");

    if (cut === -1) {
        return false;
    }

    if (prefix !== undefined && value.slice(0, cut) !== prefix) {
        return false;
    }

    return isUlid(value.slice(cut + 1));
}

/** A bare ULID, for API parameters that take one. */
export const zUlid = z
    .string()
    .regex(ULID_PATTERN, "Not a ULID")
    .meta({
        description: `A ${ULID_LENGTH}-character ULID (Crockford base32, sorts by creation time).`,
        example: "01K9ZC4X7QG0VN3M8T6B2PFHRD",
    });

/** A prefixed id as it is stored, e.g. `invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD`. */
export function zId(prefix: IdPrefix) {
    return z
        .string()
        .refine((value) => isId(value, prefix), `Not a ${prefix} id`)
        .meta({
            description: `A ${prefix} id: \`${prefix}_\` followed by a ULID.`,
            example: `${prefix}_01K9ZC4X7QG0VN3M8T6B2PFHRD`,
        });
}
