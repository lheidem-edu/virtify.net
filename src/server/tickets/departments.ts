import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { TicketDepartment } from "@/db/schema";

type Executor = Pick<typeof defaultDb, "select">;

/**
 * Departments, and the mailboxes behind them.
 *
 * A department is the unit a customer picks in the portal and the unit a
 * mailbox maps onto. The mapping is one to one and the unique index says so:
 * two departments on one mailbox would make "which queue does this belong
 * to" a coin toss whose answer differed between a notification and the
 * reconciliation pass.
 */

export async function listDepartments(
    db: Executor,
    options: { activeOnly?: boolean } = {},
): Promise<TicketDepartment[]> {
    const rows = await db
        .select()
        .from(schema.ticketDepartment)
        .orderBy(asc(schema.ticketDepartment.name));

    return options.activeOnly ? rows.filter((row) => row.active) : rows;
}

export async function departmentForMailbox(
    db: Executor,
    mailbox: string,
): Promise<TicketDepartment | null> {
    const [row] = await db
        .select()
        .from(schema.ticketDepartment)
        .where(eq(schema.ticketDepartment.mailbox, mailbox.toLowerCase()))
        .limit(1);

    return row ?? null;
}

export async function departmentById(
    db: Executor,
    id: string,
): Promise<TicketDepartment | null> {
    const [row] = await db
        .select()
        .from(schema.ticketDepartment)
        .where(eq(schema.ticketDepartment.id, id))
        .limit(1);

    return row ?? null;
}

/** Where a ticket with no department of its own goes. */
export async function defaultDepartment(
    db: Executor,
): Promise<TicketDepartment | null> {
    const [marked] = await db
        .select()
        .from(schema.ticketDepartment)
        .where(
            and(
                eq(schema.ticketDepartment.isDefault, true),
                eq(schema.ticketDepartment.active, true),
            ),
        )
        .limit(1);

    if (marked) {
        return marked;
    }

    const [first] = await db
        .select()
        .from(schema.ticketDepartment)
        .where(eq(schema.ticketDepartment.active, true))
        .orderBy(asc(schema.ticketDepartment.id))
        .limit(1);

    return first ?? null;
}

/**
 * Every address this installation sends from.
 *
 * Used by the loop protection: a message *from* one of our own mailboxes is
 * never a customer's message, whatever else it looks like. Includes inactive
 * departments on purpose — a mailbox that was switched off yesterday still
 * has our mail in it.
 */
export async function ownAddresses(
    db: Executor,
    extra: readonly (string | null | undefined)[] = [],
): Promise<string[]> {
    const rows = await db
        .select({ mailbox: schema.ticketDepartment.mailbox })
        .from(schema.ticketDepartment);

    return [
        ...new Set(
            [...rows.map((row) => row.mailbox), ...extra]
                .filter((value): value is string => Boolean(value))
                .map((value) => value.trim().toLowerCase())
                .filter((value) => value !== ""),
        ),
    ];
}
