import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import { calculateTotals } from "@/server/documents/totals";

/** A pool connection or an open transaction — a loader works in either. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Every loader takes the viewer's customer id and an admin flag. Non-admins
 * are always constrained to their own rows in the query itself, so a missing
 * check in a page cannot widen what comes back.
 */
function ownership(column: PgColumn, customerId: string, isAdmin: boolean) {
    return isAdmin ? undefined : eq(column, customerId);
}

/**
 * Passed where a loader wants a customer id it will not use. An employee has
 * no customer account at all — they are a separate login on the staff tables
 * — so there is no id to pass, and the admin flag has already lifted the
 * ownership filter.
 */
export const ANY_CUSTOMER = "";

/**
 * The address a document goes to. An account's addresses live on its
 * contacts, so the owner's is the one a document is sent to; the subquery
 * keeps that one fact in one place instead of a join every list repeats.
 */
const ownerEmail = sql<string>`(
    select c.email from ${schema.customerContact} c
    where c.customer_id = ${schema.customer}."id"
    order by case when c.role = 'owner' then 0 else 1 end, c.id
    limit 1
)`;

/** The accounts a contract, offer or invoice can be addressed to. */
export async function listCustomerAccounts(executor: Executor = db) {
    return executor
        .select({
            id: schema.customer.id,
            name: schema.customer.name,
            company: schema.customer.company,
            customerNumber: schema.customer.customerNumber,
            email: ownerEmail,
        })
        .from(schema.customer)
        .where(isNull(schema.customer.deletedAt))
        .orderBy(asc(schema.customer.customerNumber));
}

/**
 * The buyer a document is addressed to, in the shape the freeze and the XML
 * expect. The address is the account's; the e-mail is its owner contact's,
 * because an account has no address of its own to be reached at.
 */
export async function loadBuyer(customerId: string, executor: Executor = db) {
    const [row] = await executor
        .select({
            id: schema.customer.id,
            name: schema.customer.name,
            company: schema.customer.company,
            street: schema.customer.street,
            postalCode: schema.customer.postalCode,
            city: schema.customer.city,
            country: schema.customer.country,
            vatId: schema.customer.vatId,
            buyerReference: schema.customer.buyerReference,
            customerNumber: schema.customer.customerNumber,
            email: ownerEmail,
        })
        .from(schema.customer)
        .where(eq(schema.customer.id, customerId))
        .limit(1);

    return row;
}

export async function listInvoices(
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    const rows = await executor
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            status: schema.invoice.status,
            issuedAt: schema.invoice.issuedAt,
            dueAt: schema.invoice.dueAt,
            paidAt: schema.invoice.paidAt,
            recipient: schema.invoice.recipient,
            contractId: schema.invoice.contractId,
            cancelsInvoiceId: schema.invoice.cancelsInvoiceId,
            email: ownerEmail,
            /** Non-null when the contract behind the invoice carries a stored
             *  method, i.e. issuing it will collect the amount by itself. */
            collectedFrom: schema.paymentMethod.label,
        })
        .from(schema.invoice)
        .innerJoin(
            schema.customer,
            eq(schema.invoice.customerId, schema.customer.id),
        )
        .leftJoin(
            schema.contract,
            eq(schema.invoice.contractId, schema.contract.id),
        )
        // A revoked authorisation is joined away: the list must not promise a
        // collection that will not happen.
        .leftJoin(
            schema.paymentMethod,
            and(
                eq(schema.contract.paymentMethodId, schema.paymentMethod.id),
                isNull(schema.paymentMethod.revokedAt),
            ),
        )
        .where(ownership(schema.invoice.customerId, customerId, isAdmin))
        .orderBy(desc(schema.invoice.createdAt));

    return withTotals(
        rows,
        schema.invoiceItem.invoiceId,
        schema.invoiceItem,
        executor,
    );
}

/**
 * Adds each document's total in one extra query rather than one per row —
 * the alternative is an N+1 that grows with the list.
 */
async function withTotals<T extends { id: string }>(
    rows: T[],
    _key: unknown,
    table: typeof schema.invoiceItem | typeof schema.offerItem,
    executor: Executor = db,
) {
    if (rows.length === 0) {
        return rows.map((row) => ({ ...row, amount: 0 }));
    }

    const parent =
        table === schema.invoiceItem
            ? schema.invoiceItem.invoiceId
            : schema.offerItem.offerId;

    const sums = await executor
        .select({
            parentId: parent,
            amount: sql<number>`coalesce(sum(${table.quantity} * ${table.unitPriceCents}), 0)::int`,
        })
        .from(table)
        .where(
            inArray(
                parent,
                rows.map((row) => row.id),
            ),
        )
        .groupBy(parent);

    const byId = new Map(sums.map((entry) => [entry.parentId, entry.amount]));

    return rows.map((row) => ({ ...row, amount: byId.get(row.id) ?? 0 }));
}

export async function loadInvoice(
    id: string,
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    const [row] = await executor
        .select()
        .from(schema.invoice)
        .where(
            and(
                eq(schema.invoice.id, id),
                ownership(schema.invoice.customerId, customerId, isAdmin),
            ),
        );

    if (!row) {
        return null;
    }

    const items = await executor
        .select()
        .from(schema.invoiceItem)
        .where(eq(schema.invoiceItem.invoiceId, id))
        .orderBy(asc(schema.invoiceItem.position));

    const buyer = await loadBuyer(row.customerId, executor);

    return { invoice: row, items, buyer, totals: calculateTotals(items) };
}

/**
 * Every collection attempt made against one invoice, newest first. The join
 * onto the invoice is what carries the ownership rule — the payment table has
 * no viewer of its own, so it borrows the document's.
 *
 * The stored method comes along by a left join: an attempt paid through the
 * hosted checkout has none, and one made from a method the customer has since
 * revoked still has to name what it was charged from.
 */
export async function loadInvoicePayments(
    invoiceId: string,
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    return executor
        .select({
            id: schema.payment.id,
            provider: schema.payment.provider,
            status: schema.payment.status,
            amountCents: schema.payment.amountCents,
            providerRef: schema.payment.providerRef,
            captureRef: schema.payment.captureRef,
            feeCents: schema.payment.feeCents,
            failureCode: schema.payment.failureCode,
            failureMessage: schema.payment.failureMessage,
            settledAt: schema.payment.settledAt,
            createdAt: schema.payment.createdAt,
            methodLabel: schema.paymentMethod.label,
            methodRevokedAt: schema.paymentMethod.revokedAt,
        })
        .from(schema.payment)
        .innerJoin(
            schema.invoice,
            eq(schema.payment.invoiceId, schema.invoice.id),
        )
        .leftJoin(
            schema.paymentMethod,
            eq(schema.payment.paymentMethodId, schema.paymentMethod.id),
        )
        .where(
            and(
                eq(schema.payment.invoiceId, invoiceId),
                ownership(schema.invoice.customerId, customerId, isAdmin),
            ),
        )
        .orderBy(desc(schema.payment.createdAt));
}

/**
 * The account's active stored method, one row per account. Revoked ones are
 * left out: a withdrawn authorisation is not something to collect from, so it
 * must not read as one in an overview.
 */
export async function listStoredMethods(executor: Executor = db) {
    const rows = await executor
        .select({
            customerId: schema.paymentMethod.customerId,
            provider: schema.paymentMethod.provider,
            label: schema.paymentMethod.label,
            createdAt: schema.paymentMethod.createdAt,
        })
        .from(schema.paymentMethod)
        .where(isNull(schema.paymentMethod.revokedAt))
        .orderBy(desc(schema.paymentMethod.createdAt));

    // Newest first above, so the first row seen for an account wins.
    const byCustomer = new Map<string, (typeof rows)[number]>();

    for (const row of rows) {
        if (!byCustomer.has(row.customerId)) {
            byCustomer.set(row.customerId, row);
        }
    }

    return byCustomer;
}

export async function listOffers(
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    const rows = await executor
        .select({
            id: schema.offer.id,
            number: schema.offer.number,
            title: schema.offer.title,
            status: schema.offer.status,
            validUntil: schema.offer.validUntil,
            sentAt: schema.offer.sentAt,
            monthlyPriceCents: schema.offer.monthlyPriceCents,
            contractId: schema.offer.contractId,
            email: ownerEmail,
        })
        .from(schema.offer)
        .innerJoin(
            schema.customer,
            eq(schema.offer.customerId, schema.customer.id),
        )
        .where(ownership(schema.offer.customerId, customerId, isAdmin))
        .orderBy(desc(schema.offer.createdAt));

    return withTotals(
        rows,
        schema.offerItem.offerId,
        schema.offerItem,
        executor,
    );
}

export async function loadOffer(
    id: string,
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    const [row] = await executor
        .select()
        .from(schema.offer)
        .where(
            and(
                eq(schema.offer.id, id),
                ownership(schema.offer.customerId, customerId, isAdmin),
            ),
        );

    if (!row) {
        return null;
    }

    const items = await executor
        .select()
        .from(schema.offerItem)
        .where(eq(schema.offerItem.offerId, id))
        .orderBy(asc(schema.offerItem.position));

    const buyer = await loadBuyer(row.customerId, executor);

    return { offer: row, items, buyer, totals: calculateTotals(items) };
}

export async function listContracts(
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    return executor
        .select({
            id: schema.contract.id,
            number: schema.contract.number,
            title: schema.contract.title,
            status: schema.contract.status,
            serviceReadyAt: schema.contract.serviceReadyAt,
            minimumTermMonths: schema.contract.minimumTermMonths,
            monthlyPriceCents: schema.contract.monthlyPriceCents,
            terminatedTo: schema.contract.terminatedTo,
            email: ownerEmail,
        })
        .from(schema.contract)
        .innerJoin(
            schema.customer,
            eq(schema.contract.customerId, schema.customer.id),
        )
        .where(ownership(schema.contract.customerId, customerId, isAdmin))
        .orderBy(desc(schema.contract.createdAt));
}

/**
 * Everything a contract's detail page shows: the contract itself, its account,
 * every invoice that references it, the offer whose acceptance created it, and
 * the stored method it is collected from. The invoices come back so the page
 * can tell whether the contract may still be edited or deleted — both are
 * barred once it has been billed.
 */
export async function loadContract(
    id: string,
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    const [row] = await executor
        .select()
        .from(schema.contract)
        .where(
            and(
                eq(schema.contract.id, id),
                ownership(schema.contract.customerId, customerId, isAdmin),
            ),
        );

    if (!row) {
        return null;
    }

    const buyer = await loadBuyer(row.customerId, executor);

    const invoices = await executor
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            status: schema.invoice.status,
            issuedAt: schema.invoice.issuedAt,
            dueAt: schema.invoice.dueAt,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.contractId, id))
        .orderBy(desc(schema.invoice.createdAt));

    const [offer] = await executor
        .select({
            id: schema.offer.id,
            number: schema.offer.number,
            title: schema.offer.title,
            status: schema.offer.status,
            decidedAt: schema.offer.decidedAt,
        })
        .from(schema.offer)
        .where(eq(schema.offer.contractId, id));

    // Loaded even when revoked: the page has to be able to say that the
    // authorisation was withdrawn, not silently show none.
    const [method] = row.paymentMethodId
        ? await executor
              .select({
                  id: schema.paymentMethod.id,
                  provider: schema.paymentMethod.provider,
                  label: schema.paymentMethod.label,
                  revokedAt: schema.paymentMethod.revokedAt,
                  createdAt: schema.paymentMethod.createdAt,
              })
              .from(schema.paymentMethod)
              .where(eq(schema.paymentMethod.id, row.paymentMethodId))
        : [];

    return {
        contract: row,
        buyer,
        invoices: await withTotals(
            invoices,
            schema.invoiceItem.invoiceId,
            schema.invoiceItem,
            executor,
        ),
        offer: offer ?? null,
        paymentMethod: method ?? null,
    };
}

/**
 * The buyer as EN 16931 wants them, in the shape the invoice freezes at issue.
 * Kept next to formatRecipient because the two are the same snapshot in two
 * notations, and they must never disagree.
 */
export function freezeBuyer(buyer: {
    name: string;
    company: string | null;
    street: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
    vatId: string | null;
    email: string;
}) {
    return {
        buyerName: buyer.company || buyer.name,
        buyerStreet: buyer.street,
        buyerPostalCode: buyer.postalCode,
        buyerCity: buyer.city,
        buyerCountry: buyer.country,
        buyerVatId: buyer.vatId,
        buyerEmail: buyer.email,
    };
}

/**
 * The buyer block for the XML. Prefers what was frozen at issue and only falls
 * back to the account for invoices issued before the snapshot existed.
 */
export function xmlBuyer(
    invoice: {
        buyerName: string | null;
        buyerStreet: string | null;
        buyerPostalCode: string | null;
        buyerCity: string | null;
        buyerCountry: string | null;
        buyerVatId: string | null;
        buyerEmail: string | null;
    },
    buyer: {
        name: string;
        company: string | null;
        street: string | null;
        postalCode: string | null;
        city: string | null;
        country: string | null;
        vatId: string | null;
        email: string;
    },
) {
    return {
        name: invoice.buyerName ?? (buyer.company || buyer.name),
        street: invoice.buyerName ? invoice.buyerStreet : buyer.street,
        postalCode: invoice.buyerName
            ? invoice.buyerPostalCode
            : buyer.postalCode,
        city: invoice.buyerName ? invoice.buyerCity : buyer.city,
        country: invoice.buyerName ? invoice.buyerCountry : buyer.country,
        vatId: invoice.buyerName ? invoice.buyerVatId : buyer.vatId,
        email: invoice.buyerEmail ?? buyer.email,
    };
}

/** Postal address as it belongs on a document, one line per element. */
export function formatRecipient(buyer: {
    name: string;
    company: string | null;
    street: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
}) {
    return [
        buyer.company,
        buyer.name,
        buyer.street,
        [buyer.postalCode, buyer.city].filter(Boolean).join(" ") || null,
        buyer.country,
    ]
        .filter(Boolean)
        .join("\n");
}

/**
 * Every stored method of one account, revoked ones included — the customer's
 * detail page has to be able to say that an authorisation was withdrawn, not
 * silently show none.
 */
export async function loadStoredMethodsFor(
    customerId: string,
    executor: Executor = db,
) {
    return executor
        .select({
            id: schema.paymentMethod.id,
            provider: schema.paymentMethod.provider,
            label: schema.paymentMethod.label,
            revokedAt: schema.paymentMethod.revokedAt,
            createdAt: schema.paymentMethod.createdAt,
        })
        .from(schema.paymentMethod)
        .where(eq(schema.paymentMethod.customerId, customerId))
        .orderBy(desc(schema.paymentMethod.createdAt));
}
