import {
    and,
    count,
    desc,
    eq,
    ilike,
    inArray,
    lt,
    or,
    type SQL,
} from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { EmailStatus } from "@/db/schema";

/**
 * Reading the mail log, for the admin area.
 *
 * Plain queries over a `db` handle. Nothing here decides anything and nothing
 * here sends: the page shows rows, and „erneut senden" goes through
 * `resendMail`, which is the one path that may queue one.
 */

type Reader = Pick<typeof defaultDb, "select">;

export type EmailLogFilter = {
    status?: EmailStatus[];
    template?: string;
    /** Matches the recipient address or the subject, case-insensitively. */
    search?: string;
    customerId?: string;
    entityType?: string;
    entityId?: string;
};

export type EmailLogRowView = Awaited<
    ReturnType<typeof listEmails>
>["rows"][number];

/**
 * One page of the log, newest first.
 *
 * Ordered by id descending, which for a ULID is creation order (hard rule 1).
 * `cursor` is the last id of the previous page; `WHERE id < cursor` is the
 * whole of the pagination, with no offset to drift under concurrent inserts.
 */
export async function listEmails(
    db: Reader,
    options: {
        filter?: EmailLogFilter;
        cursor?: string | null;
        limit?: number;
    } = {},
) {
    const filter = options.filter ?? {};
    const limit = Math.min(options.limit ?? 50, 200);

    const where: (SQL | undefined)[] = [];

    if (filter.status && filter.status.length > 0) {
        where.push(inArray(schema.emailLog.status, filter.status));
    }

    if (filter.template) {
        where.push(eq(schema.emailLog.template, filter.template));
    }

    if (filter.customerId) {
        where.push(eq(schema.emailLog.customerId, filter.customerId));
    }

    if (filter.entityType && filter.entityId) {
        where.push(
            and(
                eq(schema.emailLog.entityType, filter.entityType),
                eq(schema.emailLog.entityId, filter.entityId),
            ),
        );
    }

    if (filter.search) {
        const needle = `%${filter.search.trim()}%`;
        where.push(
            or(
                ilike(schema.emailLog.toEmail, needle),
                ilike(schema.emailLog.subject, needle),
            ),
        );
    }

    if (options.cursor) {
        // `id < cursor` on a prefixed ULID is "older than": the prefix is
        // constant per table, so the ULID's lexicographic order is its
        // chronological one (hard rule 1).
        where.push(lt(schema.emailLog.id, options.cursor));
    }

    // One more than asked for, so the caller knows whether a next page exists
    // without a second count query.
    const rows = await db
        .select({
            id: schema.emailLog.id,
            template: schema.emailLog.template,
            locale: schema.emailLog.locale,
            dedupeKey: schema.emailLog.dedupeKey,
            toEmail: schema.emailLog.toEmail,
            toName: schema.emailLog.toName,
            subject: schema.emailLog.subject,
            status: schema.emailLog.status,
            attempts: schema.emailLog.attempts,
            maxAttempts: schema.emailLog.maxAttempts,
            runAfter: schema.emailLog.runAfter,
            sentAt: schema.emailLog.sentAt,
            transport: schema.emailLog.transport,
            lastError: schema.emailLog.lastError,
            resendCount: schema.emailLog.resendCount,
            resendOfId: schema.emailLog.resendOfId,
            createdAt: schema.emailLog.createdAt,
            customerId: schema.emailLog.customerId,
            entityType: schema.emailLog.entityType,
            entityId: schema.emailLog.entityId,
            customerName: schema.customer.name,
            customerNumber: schema.customer.customerNumber,
        })
        .from(schema.emailLog)
        .leftJoin(
            schema.customer,
            eq(schema.emailLog.customerId, schema.customer.id),
        )
        .where(where.length > 0 ? and(...where) : undefined)
        .orderBy(desc(schema.emailLog.id))
        .limit(limit + 1);

    return {
        rows: rows.slice(0, limit),
        nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
}

export async function emailById(db: Reader, id: string) {
    const [row] = await db
        .select()
        .from(schema.emailLog)
        .where(eq(schema.emailLog.id, id))
        .limit(1);

    return row ?? null;
}

/** How many rows are in each state. The headline of the admin page. */
export async function emailCounts(
    db: Reader,
): Promise<Record<EmailStatus, number>> {
    const rows = await db
        .select({
            status: schema.emailLog.status,
            count: count(),
        })
        .from(schema.emailLog)
        .groupBy(schema.emailLog.status);

    const out: Record<EmailStatus, number> = {
        pending: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        unknown: 0,
        abandoned: 0,
    };

    for (const row of rows) {
        out[row.status] = Number(row.count);
    }

    return out;
}

/**
 * The events that have not been turned into notifications yet, and the ones
 * that gave up trying.
 *
 * Shown beside the mail because they answer a different question: a mail that
 * is not in the log at all may be an event that never dispatched, and without
 * this the operator would have nothing to look at.
 */
export async function eventBacklog(db: Reader, limit = 25) {
    return db
        .select({
            id: schema.domainEvent.id,
            type: schema.domainEvent.type,
            status: schema.domainEvent.status,
            entityType: schema.domainEvent.entityType,
            entityId: schema.domainEvent.entityId,
            attempts: schema.domainEvent.attempts,
            maxAttempts: schema.domainEvent.maxAttempts,
            runAfter: schema.domainEvent.runAfter,
            lastError: schema.domainEvent.lastError,
            occurredAt: schema.domainEvent.occurredAt,
            customerName: schema.customer.name,
        })
        .from(schema.domainEvent)
        .leftJoin(
            schema.customer,
            eq(schema.domainEvent.customerId, schema.customer.id),
        )
        .where(inArray(schema.domainEvent.status, ["pending", "abandoned"]))
        .orderBy(desc(schema.domainEvent.id))
        .limit(limit);
}

/**
 * The last few events on one account, for the portal's activity list.
 *
 * Scoped by the caller, which under `(client)` is always
 * `getCurrentCustomer()` — this function takes an id and does not look one up
 * (rule 5).
 */
export async function recentEventsFor(
    db: Reader,
    customerId: string,
    limit = 8,
) {
    return db
        .select({
            id: schema.domainEvent.id,
            type: schema.domainEvent.type,
            entityType: schema.domainEvent.entityType,
            entityId: schema.domainEvent.entityId,
            payload: schema.domainEvent.payload,
            occurredAt: schema.domainEvent.occurredAt,
        })
        .from(schema.domainEvent)
        .where(eq(schema.domainEvent.customerId, customerId))
        .orderBy(desc(schema.domainEvent.id))
        .limit(limit);
}
