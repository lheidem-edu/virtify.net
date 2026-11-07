import "server-only";
import { and, asc, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import type { PaymentProvider } from "@/db/schema";
import { OPEN_INVOICE_STATUSES } from "@/db/schema";

/**
 * Reading the transactions, for the admin list and for
 * `GET /api/v1/transactions`.
 *
 * Both go through here on purpose: a list the operator sees and a list an API
 * key sees must agree about what a transaction is. The scoping is the
 * difference, and it is a parameter — a customer-scoped key passes its own
 * id, a staff key passes null, and there is no third way to reach these rows.
 */

type Db = typeof defaultDb;
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type TransactionFilters = {
    /** Null for staff: everything. Otherwise only this account's. */
    customerId?: string | null;
    invoiceId?: string | null;
    provider?: PaymentProvider | null;
    status?: (typeof schema.paymentStatus.enumValues)[number] | null;
    kind?: (typeof schema.paymentKind.enumValues)[number] | null;
};

function conditions(filters: TransactionFilters): SQL[] {
    return [
        filters.customerId
            ? eq(schema.payment.customerId, filters.customerId)
            : undefined,
        filters.invoiceId
            ? eq(schema.payment.invoiceId, filters.invoiceId)
            : undefined,
        filters.provider
            ? eq(schema.payment.provider, filters.provider)
            : undefined,
        filters.status ? eq(schema.payment.status, filters.status) : undefined,
        filters.kind ? eq(schema.payment.kind, filters.kind) : undefined,
    ].filter((one): one is SQL => one !== undefined);
}

const COLUMNS = {
    id: schema.payment.id,
    invoiceId: schema.payment.invoiceId,
    customerId: schema.payment.customerId,
    provider: schema.payment.provider,
    status: schema.payment.status,
    kind: schema.payment.kind,
    purpose: schema.payment.purpose,
    parentPaymentId: schema.payment.parentPaymentId,
    amountCents: schema.payment.amountCents,
    refundedCents: schema.payment.refundedCents,
    currency: schema.payment.currency,
    providerRef: schema.payment.providerRef,
    captureRef: schema.payment.captureRef,
    feeCents: schema.payment.feeCents,
    failureCode: schema.payment.failureCode,
    failureMessage: schema.payment.failureMessage,
    note: schema.payment.note,
    settledAt: schema.payment.settledAt,
    createdAt: schema.payment.createdAt,
};

export type TransactionRow = {
    [K in keyof typeof COLUMNS]: (typeof schema.payment.$inferSelect)[K];
};

/** The admin list: newest first, with the names an operator needs to read it. */
export async function listTransactions(
    executor: Executor,
    filters: TransactionFilters = {},
    limit = 200,
) {
    const where = conditions(filters);

    return executor
        .select({
            ...COLUMNS,
            invoiceNumber: schema.invoice.number,
            invoiceStatus: schema.invoice.status,
            customerName: schema.customer.name,
            customerNumber: schema.customer.customerNumber,
            methodLabel: schema.paymentMethod.label,
        })
        .from(schema.payment)
        .leftJoin(
            schema.invoice,
            eq(schema.payment.invoiceId, schema.invoice.id),
        )
        .leftJoin(
            schema.customer,
            eq(schema.payment.customerId, schema.customer.id),
        )
        .leftJoin(
            schema.paymentMethod,
            eq(schema.payment.paymentMethodId, schema.paymentMethod.id),
        )
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(schema.payment.id))
        .limit(limit);
}

/**
 * Cursor pagination for `/api/v1/transactions`: `WHERE id > $cursor ORDER BY
 * id`. The ULID is the cursor, which is what rule 1 keeps the prefix constant
 * per table for.
 */
export async function listTransactionsPage(
    executor: Executor,
    options: TransactionFilters & { cursor?: string; limit: number },
) {
    const where = [
        ...conditions(options),
        options.cursor ? gt(schema.payment.id, options.cursor) : undefined,
    ].filter((one): one is SQL => one !== undefined);

    const rows = await executor
        .select(COLUMNS)
        .from(schema.payment)
        .where(where.length ? and(...where) : undefined)
        .orderBy(asc(schema.payment.id))
        .limit(options.limit + 1);

    const has_more = rows.length > options.limit;
    const data = has_more ? rows.slice(0, options.limit) : rows;

    return {
        data,
        has_more,
        next_cursor: has_more ? (data.at(-1)?.id ?? null) : null,
    };
}

/**
 * One transaction, scoped. A caller who may not see it is told it is not
 * there — never 403, which would confirm the id exists.
 */
export async function loadTransaction(
    executor: Executor,
    id: string,
    customerId: string | null,
) {
    const where = [
        eq(schema.payment.id, id),
        customerId ? eq(schema.payment.customerId, customerId) : undefined,
    ].filter((one): one is SQL => one !== undefined);

    const [row] = await executor
        .select(COLUMNS)
        .from(schema.payment)
        .where(and(...where));

    return row ?? null;
}

/** The invoices a manual booking can be made against: issued and still open. */
export async function openInvoicesFor(
    executor: Executor,
    customerId?: string | null,
) {
    const where = [
        inArray(schema.invoice.status, [...OPEN_INVOICE_STATUSES]),
        customerId ? eq(schema.invoice.customerId, customerId) : undefined,
    ].filter((one): one is SQL => one !== undefined);

    return executor
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            customerId: schema.invoice.customerId,
            customerName: schema.customer.name,
            grossCents: schema.invoice.grossCents,
            creditedCents: schema.invoice.creditedCents,
            paidCents: schema.invoice.paidCents,
            dueAt: schema.invoice.dueAt,
        })
        .from(schema.invoice)
        .innerJoin(
            schema.customer,
            eq(schema.invoice.customerId, schema.customer.id),
        )
        .where(and(...where))
        .orderBy(asc(schema.invoice.dueAt));
}
