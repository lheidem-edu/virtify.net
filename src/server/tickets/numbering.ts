import { sql } from "drizzle-orm";
import { type db as Database, schema } from "@/db";

/**
 * Ticket numbers.
 *
 * Not a legal document number — § 14 UStG has nothing to say about a support
 * ticket — but it is the **strongest threading signal there is**, so it has
 * one hard property: a number is never handed out twice. That is why the
 * counter is not per year the way the invoice series is. `[TKT-00042]` in a
 * subject line two Januaries apart has to mean one conversation, or a reply
 * to a 2026 ticket joins a 2027 one belonging to somebody else.
 */

export const TICKET_NUMBER_PAD = 5;

type Tx = Parameters<Parameters<typeof Database.transaction>[0]>[0];

export function formatTicketNumber(value: number): string {
    return `TKT-${String(value).padStart(TICKET_NUMBER_PAD, "0")}`;
}

/** The tag that goes in a subject line, and that a reply comes back with. */
export function ticketTag(value: number): string {
    return `[${formatTicketNumber(value)}]`;
}

/**
 * Reads a ticket number out of a subject line.
 *
 * Deliberately generous about what it accepts and strict about what it
 * means: any number of digits, upper or lower case, surrounded by square
 * brackets. Mail clients fold long subjects, translate `Re:` into `Aw:` and
 * `Antwort:`, and insert list tags of their own — but none of them rewrites
 * the digits inside a bracket.
 *
 * Returns null for anything that is not one, including a tag with a number
 * too long to be real (which is how a pasted order id stops looking like a
 * ticket).
 */
export function parseTicketNumber(subject: string | null): number | null {
    if (!subject) {
        return null;
    }

    const match = /\[\s*TKT[\s-]?(\d{1,9})\s*\]/i.exec(subject);

    if (!match) {
        return null;
    }

    const value = Number(match[1]);

    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Reserves the next ticket number. Must run in the transaction that writes
 * the ticket: the upsert holds a row lock for its duration, so two tickets
 * opened in the same instant serialise rather than collide.
 */
export async function nextTicketNumber(tx: Tx): Promise<number> {
    const [row] = await tx
        .insert(schema.documentCounter)
        .values({ scope: "ticket", value: 1 })
        .onConflictDoUpdate({
            target: schema.documentCounter.scope,
            set: { value: sql`${schema.documentCounter.value} + 1` },
        })
        .returning({ value: schema.documentCounter.value });

    return row.value;
}

/**
 * The subject a reply goes out with: the tag first, so a client that
 * truncates or that prefixes `Re:` still leaves it where the parser looks.
 */
export function subjectWithTag(number: number, subject: string): string {
    const tag = ticketTag(number);

    return subject.includes(tag) ? subject : `${tag} ${subject}`.trim();
}
