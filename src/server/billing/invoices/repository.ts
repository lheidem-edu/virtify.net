import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import {
    ANY_CUSTOMER,
    invoiceAmount,
    loadBuyer,
} from "@/server/documents/repository";
import { loadSettings } from "@/server/settings";
import { determineTax } from "./tax-context";
import { calculateTotals, type DocumentTotals } from "./totals";

/**
 * Reading invoices and credit notes.
 *
 * Every loader takes the viewer's customer id and an admin flag and puts the
 * ownership rule into the query itself (CLAUDE.md rule 5), so a page that
 * forgets to check still cannot widen what comes back. A row the caller may
 * not see comes back as `null`, and the caller answers 404 — never 403.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function ownership(column: PgColumn, customerId: string, isAdmin: boolean) {
    return isAdmin ? undefined : eq(column, customerId);
}

export { ANY_CUSTOMER };

/**
 * The totals of a stored document.
 *
 * A finalized document's lines carry their own tax snapshot and are simply
 * added up. A draft has none — tax is decided at finalization — so it is
 * shown under the strategy in force today, which is what the operator is
 * about to finalize it under.
 */
async function storedTotals(
    executor: Executor,
    items: {
        description: string;
        detail: string | null;
        quantity: number;
        unitCode: string;
        unitPriceCents: number;
        taxRateBp: number | null;
        taxCategory: string | null;
        taxRule: string | null;
        servicePeriodStart: Date | null;
        servicePeriodEnd: Date | null;
    }[],
    buyer: Parameters<typeof determineTax>[1],
    at: Date,
    frozen: boolean,
): Promise<{
    totals: DocumentTotals;
    notes: string[];
    strategy: string | null;
}> {
    const determined = frozen
        ? null
        : await determineTax(executor, buyer, await loadSettings(), at);

    const determination = determined?.determination ?? null;
    const notes = determined?.notes ?? [];

    return {
        notes,
        strategy: determined?.strategy.id ?? null,
        totals: calculateTotals(
            items.map((item) => ({
                description: item.description,
                detail: item.detail,
                quantity: item.quantity,
                unitCode: item.unitCode,
                unitPriceCents: item.unitPriceCents,
                taxRateBp: item.taxRateBp ?? determination?.rateBp ?? 0,
                taxCategory:
                    (item.taxCategory as "S" | "E" | "AE" | "O" | "Z" | "G") ??
                    determination?.category ??
                    "E",
                taxRule:
                    item.taxRule ?? determination?.rule ?? "kleinunternehmer",
                servicePeriodStart: item.servicePeriodStart,
                servicePeriodEnd: item.servicePeriodEnd,
            })),
        ),
    };
}

/**
 * The address a document goes to. An account's addresses live on its
 * contacts, so the owner's is the one documents are sent to.
 */
const ownerEmail = sql<string>`(
    select c.email from ${schema.customerContact} c
    where c.customer_id = ${schema.customer}."id"
    order by case when c.role = 'owner' then 0 else 1 end, c.id
    limit 1
)`;

export async function listInvoices(
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    return (
        executor
            .select({
                id: schema.invoice.id,
                number: schema.invoice.number,
                status: schema.invoice.status,
                currency: schema.invoice.currency,
                issuedAt: schema.invoice.issuedAt,
                dueAt: schema.invoice.dueAt,
                paidAt: schema.invoice.paidAt,
                recipient: schema.invoice.recipient,
                contractId: schema.invoice.contractId,
                taxStrategy: schema.invoice.taxStrategy,
                netCents: schema.invoice.netCents,
                taxCents: schema.invoice.taxCents,
                creditedCents: schema.invoice.creditedCents,
                amount: invoiceAmount,
                email: ownerEmail,
                /** Non-null when the contract behind the invoice carries a stored
                 *  method, i.e. finalizing it will collect the amount by itself. */
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
                    eq(
                        schema.contract.paymentMethodId,
                        schema.paymentMethod.id,
                    ),
                    isNull(schema.paymentMethod.revokedAt),
                ),
            )
            .where(ownership(schema.invoice.customerId, customerId, isAdmin))
            .orderBy(desc(schema.invoice.createdAt))
    );
}

/** Cursor pagination for `/api/v1/invoices`: `WHERE id > $cursor ORDER BY id`. */
export async function listInvoicesPage(
    executor: Executor,
    options: {
        customerId?: string | null;
        status?: string | null;
        /** A draft has no number and no legal existence; a customer key
         *  never sees one, so it is excluded in the query rather than
         *  filtered out of the page — otherwise `limit` and `has_more`
         *  would be counting rows the caller never receives. */
        excludeDrafts?: boolean;
        cursor?: string;
        limit: number;
    },
) {
    const filters = [
        options.customerId
            ? eq(schema.invoice.customerId, options.customerId)
            : undefined,
        options.status
            ? eq(
                  schema.invoice.status,
                  options.status as (typeof schema.invoiceStatus.enumValues)[number],
              )
            : undefined,
        options.excludeDrafts ? ne(schema.invoice.status, "draft") : undefined,
        options.cursor ? gt(schema.invoice.id, options.cursor) : undefined,
    ].filter(Boolean);

    const rows = await executor
        .select()
        .from(schema.invoice)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(schema.invoice.id))
        .limit(options.limit + 1);

    const has_more = rows.length > options.limit;
    const data = has_more ? rows.slice(0, options.limit) : rows;

    return {
        data,
        has_more,
        next_cursor: has_more ? (data.at(-1)?.id ?? null) : null,
    };
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

    const { totals, notes, strategy } = await storedTotals(
        executor,
        items,
        buyer,
        row.issuedAt ?? new Date(),
        row.status !== "draft",
    );

    const creditNotes = await executor
        .select({
            id: schema.creditNote.id,
            number: schema.creditNote.number,
            kind: schema.creditNote.kind,
            reason: schema.creditNote.reason,
            issuedAt: schema.creditNote.issuedAt,
            netCents: schema.creditNote.netCents,
            taxCents: schema.creditNote.taxCents,
            grossCents: schema.creditNote.grossCents,
        })
        .from(schema.creditNote)
        .where(eq(schema.creditNote.invoiceId, id))
        .orderBy(asc(schema.creditNote.issuedAt));

    return {
        invoice: row,
        items,
        buyer,
        totals,
        creditNotes,
        /** Frozen on a finalized document; the live ones on a draft. */
        taxNotes: row.taxNote ? [row.taxNote] : notes,
        /**
         * The strategy the document carries, or — for a draft, which carries
         * none — the one it would be finalized under today. A draft that is
         * about to be issued with 19 % has to say so, or the operator checks
         * it against a document that shows no tax at all.
         */
        effectiveTaxStrategy: row.taxStrategy ?? strategy,
    };
}

export async function listCreditNotes(
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    return executor
        .select({
            id: schema.creditNote.id,
            number: schema.creditNote.number,
            kind: schema.creditNote.kind,
            issuedAt: schema.creditNote.issuedAt,
            grossCents: schema.creditNote.grossCents,
            currency: schema.creditNote.currency,
            recipient: schema.creditNote.recipient,
            invoiceId: schema.creditNote.invoiceId,
            invoiceNumber: schema.invoice.number,
            email: ownerEmail,
        })
        .from(schema.creditNote)
        .innerJoin(
            schema.customer,
            eq(schema.creditNote.customerId, schema.customer.id),
        )
        .innerJoin(
            schema.invoice,
            eq(schema.creditNote.invoiceId, schema.invoice.id),
        )
        .where(ownership(schema.creditNote.customerId, customerId, isAdmin))
        .orderBy(desc(schema.creditNote.issuedAt));
}

export async function loadCreditNote(
    id: string,
    customerId: string,
    isAdmin: boolean,
    executor: Executor = db,
) {
    const [row] = await executor
        .select()
        .from(schema.creditNote)
        .where(
            and(
                eq(schema.creditNote.id, id),
                ownership(schema.creditNote.customerId, customerId, isAdmin),
            ),
        );

    if (!row) {
        return null;
    }

    const items = await executor
        .select()
        .from(schema.creditNoteItem)
        .where(eq(schema.creditNoteItem.creditNoteId, id))
        .orderBy(asc(schema.creditNoteItem.position));

    const [invoice] = await executor
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            issuedAt: schema.invoice.issuedAt,
            grossCents: schema.invoice.grossCents,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.id, row.invoiceId));

    return {
        creditNote: row,
        items,
        invoice: invoice ?? null,
        totals: calculateTotals(
            items.map((item) => ({
                description: item.description,
                detail: item.detail,
                quantity: item.quantity,
                unitCode: item.unitCode,
                unitPriceCents: item.unitPriceCents,
                taxRateBp: item.taxRateBp,
                taxCategory: item.taxCategory as "S" | "E" | "AE" | "O",
                taxRule: item.taxRule,
                servicePeriodStart: item.servicePeriodStart,
                servicePeriodEnd: item.servicePeriodEnd,
            })),
        ),
    };
}

/**
 * How much of each line of an invoice has already been credited. A partial
 * correction may never take back more than was charged, and the only way to
 * know is to add up what the earlier ones took.
 */
export async function creditedQuantities(
    executor: Executor,
    invoiceId: string,
): Promise<Map<string, number>> {
    const rows = await executor
        .select({
            invoiceItemId: schema.creditNoteItem.invoiceItemId,
            quantity: sql<number>`sum(${schema.creditNoteItem.quantity})::int`,
        })
        .from(schema.creditNoteItem)
        .innerJoin(
            schema.creditNote,
            eq(schema.creditNoteItem.creditNoteId, schema.creditNote.id),
        )
        .where(eq(schema.creditNote.invoiceId, invoiceId))
        .groupBy(schema.creditNoteItem.invoiceItemId);

    return new Map(
        rows
            .filter((row) => row.invoiceItemId !== null)
            .map((row) => [row.invoiceItemId as string, row.quantity]),
    );
}

/** Invoice ids whose rows a page already holds, for a bulk credit-note join. */
export async function creditNotesFor(executor: Executor, invoiceIds: string[]) {
    if (invoiceIds.length === 0) {
        return new Map<string, { id: string; number: string }[]>();
    }

    const rows = await executor
        .select({
            id: schema.creditNote.id,
            number: schema.creditNote.number,
            invoiceId: schema.creditNote.invoiceId,
        })
        .from(schema.creditNote)
        .where(inArray(schema.creditNote.invoiceId, invoiceIds))
        .orderBy(asc(schema.creditNote.number));

    const byInvoice = new Map<string, { id: string; number: string }[]>();

    for (const row of rows) {
        const list = byInvoice.get(row.invoiceId) ?? [];
        list.push({ id: row.id, number: row.number });
        byInvoice.set(row.invoiceId, list);
    }

    return byInvoice;
}
