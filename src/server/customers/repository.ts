import { and, asc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { createId } from "@/lib/ulid";
import { type Actor, audit, diff } from "@/server/audit";
import type { CustomerInput, CustomerPatch } from "@/server/customers/schema";
import { nextCustomerNumber } from "@/server/documents/numbering";

/**
 * Everything that reads or writes a billing account. Plain functions over a
 * `db` or a transaction, so a server action, an API route and a test all call
 * the same code and cannot drift apart.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export const DEFAULT_PAGE_SIZE = 25;

export async function getCustomer(db: Executor, id: string) {
    const [row] = await db
        .select()
        .from(schema.customer)
        .where(
            and(eq(schema.customer.id, id), isNull(schema.customer.deletedAt)),
        )
        .limit(1);

    return row ?? null;
}

/**
 * The account a login acts for. A `user` may hold several contacts — a
 * Steuerberater on two companies — so the owner contact wins and the rest
 * are ordered by id, which is the account that was opened first.
 *
 * There is no account switcher yet: the table allows more than one, the
 * portal picks one, and the switcher is Phase 9's.
 */
export async function customerForUser(db: Executor, userId: string) {
    const [row] = await db
        .select({
            customer: schema.customer,
            contact: schema.customerContact,
        })
        .from(schema.customerContact)
        .innerJoin(
            schema.customer,
            eq(schema.customerContact.customerId, schema.customer.id),
        )
        .where(
            and(
                eq(schema.customerContact.userId, userId),
                isNull(schema.customer.deletedAt),
            ),
        )
        .orderBy(
            // `owner` sorts before `contact` as text, but saying so out loud
            // is cheaper than relying on the enum's spelling.
            sql`case when ${schema.customerContact.role} = 'owner' then 0 else 1 end`,
            asc(schema.customerContact.id),
        )
        .limit(1);

    return row ?? null;
}

export async function listContacts(db: Executor, customerId: string) {
    return db
        .select({
            id: schema.customerContact.id,
            userId: schema.customerContact.userId,
            role: schema.customerContact.role,
            email: schema.customerContact.email,
            canBilling: schema.customerContact.canBilling,
            canTechnical: schema.customerContact.canTechnical,
            canTickets: schema.customerContact.canTickets,
            name: schema.user.name,
            emailVerified: schema.user.emailVerified,
            createdAt: schema.customerContact.createdAt,
        })
        .from(schema.customerContact)
        .innerJoin(
            schema.user,
            eq(schema.customerContact.userId, schema.user.id),
        )
        .where(eq(schema.customerContact.customerId, customerId))
        .orderBy(asc(schema.customerContact.id));
}

export type ListOptions = {
    /** The last id of the previous page; rows are returned after it. */
    cursor?: string | null;
    limit?: number;
    /** Matches number, name, company or a contact's address. */
    query?: string | null;
    status?: "active" | "suspended" | "closed" | null;
};

/**
 * Cursor pagination on the primary key: `WHERE id > $cursor ORDER BY id`
 * reads the index and cannot shift under a reader when a row is inserted
 * while they page, which an offset would.
 */
export async function listCustomers(db: Executor, options: ListOptions = {}) {
    const limit = Math.min(
        Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1),
        100,
    );
    const term = options.query?.trim();

    const filters: (ReturnType<typeof eq> | undefined)[] = [
        isNull(schema.customer.deletedAt),
    ];

    if (options.cursor) {
        filters.push(gt(schema.customer.id, options.cursor));
    }

    if (options.status) {
        filters.push(eq(schema.customer.status, options.status));
    }

    if (term) {
        const like = `%${term}%`;
        const number = Number.parseInt(term, 10);

        filters.push(
            or(
                ilike(schema.customer.name, like),
                ilike(schema.customer.company, like),
                Number.isNaN(number)
                    ? undefined
                    : eq(schema.customer.customerNumber, number),
                sql`exists (select 1 from ${schema.customerContact} c
                    where c.customer_id = ${schema.customer}."id"
                      and c.email ilike ${like})`,
            ),
        );
    }

    // One row more than asked for: its presence is the answer to `has_more`
    // without a second count query over the whole table.
    const rows = await db
        .select()
        .from(schema.customer)
        .where(and(...filters))
        .orderBy(asc(schema.customer.id))
        .limit(limit + 1);

    const page = rows.slice(0, limit);

    return {
        data: page,
        has_more: rows.length > limit,
        next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
}

/**
 * Creates a billing account. The number comes from the same gapless counter
 * sign-ups use, so the two series never overlap.
 */
export async function createCustomer(
    db: Db,
    input: CustomerInput,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .insert(schema.customer)
            .values({
                ...input,
                customerNumber: await nextCustomerNumber(tx),
            })
            .returning();

        await audit(tx, {
            actor,
            action: "customer.create",
            entityType: "customer",
            entityId: row.id,
            after: { ...input, customerNumber: row.customerNumber },
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

/**
 * Applies a patch and records what moved. Returns null when there is no such
 * customer, so a caller cannot mistake "not yours" for "saved".
 */
export async function updateCustomer(
    db: Db,
    id: string,
    patch: CustomerPatch,
    actor: Actor,
    origin?: { ip?: string | null; userAgent?: string | null },
) {
    return db.transaction(async (tx) => {
        const before = await getCustomer(tx, id);

        if (!before) {
            return null;
        }

        const changes = diff(
            before as unknown as Record<string, unknown>,
            patch as Record<string, unknown>,
        );

        if (!changes) {
            return before;
        }

        const [row] = await tx
            .update(schema.customer)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(schema.customer.id, id))
            .returning();

        await audit(tx, {
            actor,
            action: "customer.update",
            entityType: "customer",
            entityId: id,
            before: changes.before,
            after: changes.after,
            ip: origin?.ip,
            userAgent: origin?.userAgent,
        });

        return row;
    });
}

/**
 * The account a new sign-up gets, with the login as its owner. Runs in the
 * caller's transaction: a login without an account would be able to sign in
 * and see nothing at all.
 */
export async function createCustomerForUser(
    tx: Executor,
    user: { id: string; name: string; email: string },
    input?: Partial<CustomerInput>,
) {
    const [row] = await tx
        .insert(schema.customer)
        .values({
            ...input,
            name: input?.name?.trim() || user.name,
            customerNumber: await nextCustomerNumber(tx),
        })
        .returning();

    await tx.insert(schema.customerContact).values({
        id: createId("customercontact"),
        customerId: row.id,
        userId: user.id,
        role: "owner",
        email: user.email,
    });

    return row;
}

export async function auditTrail(db: Executor, entityId: string, limit = 50) {
    return db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, entityId))
        .orderBy(sql`${schema.auditLog.id} desc`)
        .limit(limit);
}
