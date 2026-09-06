import "server-only";
import { sql } from "drizzle-orm";
import { type db as Database, db, schema } from "@/lib/db";

/**
 * Number patterns. `{YEAR}` is the issuing year, `{SEQ}` the counter padded
 * to the given width. Change these to match an existing scheme — the only
 * hard rule is that a number is never handed out twice, which the unique
 * index on the column enforces regardless of the pattern.
 */
export const NUMBERING = {
    invoice: { pattern: "RE-{YEAR}-{SEQ}", pad: 4, perYear: true },
    offer: { pattern: "AN-{YEAR}-{SEQ}", pad: 4, perYear: true },
} as const;

/**
 * Customer numbers continue an existing series. Set this to the highest
 * number already in use before the first sign-up, so the two never overlap.
 */
export const CUSTOMER_NUMBER_START = 10000;

export type DocumentKind = keyof typeof NUMBERING;

type Tx = Parameters<Parameters<typeof Database.transaction>[0]>[0];

/**
 * Reserves the next number for `kind`. Must run inside the transaction that
 * also writes the document: the upsert takes a row lock for its duration, so
 * two concurrent issues serialise rather than collide.
 */
export async function nextNumber(tx: Tx, kind: DocumentKind, at: Date) {
    const config = NUMBERING[kind];
    const year = at.getFullYear();
    const scope = config.perYear ? `${kind}:${year}` : kind;

    const [row] = await tx
        .insert(schema.documentCounter)
        .values({ scope, value: 1 })
        .onConflictDoUpdate({
            target: schema.documentCounter.scope,
            set: { value: sql`${schema.documentCounter.value} + 1` },
        })
        .returning({ value: schema.documentCounter.value });

    return config.pattern
        .replace("{YEAR}", String(year))
        .replace("{SEQ}", String(row.value).padStart(config.pad, "0"));
}

/**
 * Assigns the next customer number. Runs on sign-up, before the row is
 * written, so every account has one from the start.
 */
export async function nextCustomerNumber() {
    const [row] = await db
        .insert(schema.documentCounter)
        .values({ scope: "customer", value: CUSTOMER_NUMBER_START + 1 })
        .onConflictDoUpdate({
            target: schema.documentCounter.scope,
            set: { value: sql`${schema.documentCounter.value} + 1` },
        })
        .returning({ value: schema.documentCounter.value });

    return row.value;
}
