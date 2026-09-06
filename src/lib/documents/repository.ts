import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, schema } from "@/lib/db";
import { calculateTotals } from "@/lib/documents/totals";

/**
 * Every loader takes the viewer's id and an admin flag. Non-admins are always
 * constrained to their own rows in the query itself, so a missing check in a
 * page cannot widen what comes back.
 */
function ownership(column: PgColumn, userId: string, isAdmin: boolean) {
    return isAdmin ? undefined : eq(column, userId);
}

export async function listInvoices(userId: string, isAdmin: boolean) {
    return db
        .select({
            id: schema.invoice.id,
            number: schema.invoice.number,
            status: schema.invoice.status,
            issuedAt: schema.invoice.issuedAt,
            dueAt: schema.invoice.dueAt,
            paidAt: schema.invoice.paidAt,
            recipient: schema.invoice.recipient,
            email: schema.user.email,
        })
        .from(schema.invoice)
        .innerJoin(schema.user, eq(schema.invoice.userId, schema.user.id))
        .where(ownership(schema.invoice.userId, userId, isAdmin))
        .orderBy(desc(schema.invoice.createdAt));
}

export async function loadInvoice(
    id: string,
    userId: string,
    isAdmin: boolean,
) {
    const [row] = await db
        .select()
        .from(schema.invoice)
        .where(
            and(
                eq(schema.invoice.id, id),
                ownership(schema.invoice.userId, userId, isAdmin),
            ),
        );

    if (!row) {
        return null;
    }

    const items = await db
        .select()
        .from(schema.invoiceItem)
        .where(eq(schema.invoiceItem.invoiceId, id))
        .orderBy(asc(schema.invoiceItem.position));

    const [buyer] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, row.userId));

    return { invoice: row, items, buyer, totals: calculateTotals(items) };
}

export async function listOffers(userId: string, isAdmin: boolean) {
    return db
        .select({
            id: schema.offer.id,
            number: schema.offer.number,
            title: schema.offer.title,
            status: schema.offer.status,
            validUntil: schema.offer.validUntil,
            sentAt: schema.offer.sentAt,
            monthlyPriceCents: schema.offer.monthlyPriceCents,
            email: schema.user.email,
        })
        .from(schema.offer)
        .innerJoin(schema.user, eq(schema.offer.userId, schema.user.id))
        .where(ownership(schema.offer.userId, userId, isAdmin))
        .orderBy(desc(schema.offer.createdAt));
}

export async function loadOffer(id: string, userId: string, isAdmin: boolean) {
    const [row] = await db
        .select()
        .from(schema.offer)
        .where(
            and(
                eq(schema.offer.id, id),
                ownership(schema.offer.userId, userId, isAdmin),
            ),
        );

    if (!row) {
        return null;
    }

    const items = await db
        .select()
        .from(schema.offerItem)
        .where(eq(schema.offerItem.offerId, id))
        .orderBy(asc(schema.offerItem.position));

    const [buyer] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, row.userId));

    return { offer: row, items, buyer, totals: calculateTotals(items) };
}

export async function listContracts(userId: string, isAdmin: boolean) {
    return db
        .select({
            id: schema.contract.id,
            number: schema.contract.number,
            title: schema.contract.title,
            status: schema.contract.status,
            serviceReadyAt: schema.contract.serviceReadyAt,
            minimumTermMonths: schema.contract.minimumTermMonths,
            monthlyPriceCents: schema.contract.monthlyPriceCents,
            terminatedTo: schema.contract.terminatedTo,
            email: schema.user.email,
        })
        .from(schema.contract)
        .innerJoin(schema.user, eq(schema.contract.userId, schema.user.id))
        .where(ownership(schema.contract.userId, userId, isAdmin))
        .orderBy(desc(schema.contract.createdAt));
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
