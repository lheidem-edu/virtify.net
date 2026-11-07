import "server-only";
import { z } from "zod";
import type { schema } from "@/db";
import { zId } from "@/lib/ulid";
import { DEFAULT_UNIT_CODE } from "./totals";

/**
 * The wire shape of an invoice, and the parsers for what comes in.
 *
 * Kept next to the service rather than in the route so that the admin area,
 * the API and the tests all agree on what an invoice looks like from outside
 * — snake_case on the wire, cents as integers, dates as ISO-8601 in UTC.
 */

export const listQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(["draft", "unpaid", "paid", "cancelled"]).optional(),
    customer_id: z.string().optional(),
});

const itemSchema = z.object({
    description: z.string().trim().min(1).max(500),
    detail: z.string().trim().max(500).nullish(),
    quantity: z
        .int()
        .min(-9999)
        .max(9999)
        .refine((value) => value !== 0, {
            message: "Eine Position mit Menge 0 gehört nicht auf die Rechnung.",
        }),
    unit_code: z.string().trim().min(1).max(8).default(DEFAULT_UNIT_CODE),
    unit_price_cents: z.int().min(-99_999_999).max(99_999_999),
    service_period_start: z.iso.datetime().nullish(),
    service_period_end: z.iso.datetime().nullish(),
});

export const createBodySchema = z.object({
    customer_id: zId("customer"),
    contract_id: zId("contract").nullish(),
    intro_text: z.string().trim().max(2000).nullish(),
    note: z.string().trim().max(2000).nullish(),
    service_period_start: z.iso.datetime().nullish(),
    service_period_end: z.iso.datetime().nullish(),
    items: z.array(itemSchema).min(1).max(200),
});

export type CreateBody = z.infer<typeof createBodySchema>;

function date(value: string | null | undefined): Date | null {
    return value ? new Date(value) : null;
}

/** The wire body as the service's input. */
export function fromWire(body: CreateBody) {
    return {
        customerId: body.customer_id,
        contractId: body.contract_id ?? null,
        introText: body.intro_text ?? null,
        note: body.note ?? null,
        servicePeriodStart: date(body.service_period_start),
        servicePeriodEnd: date(body.service_period_end),
        items: body.items.map((item) => ({
            description: item.description,
            detail: item.detail ?? null,
            quantity: item.quantity,
            unitCode: item.unit_code,
            unitPriceCents: item.unit_price_cents,
            servicePeriodStart: date(item.service_period_start),
            servicePeriodEnd: date(item.service_period_end),
        })),
    };
}

type InvoiceRow = typeof schema.invoice.$inferSelect;
type InvoiceItemRow = typeof schema.invoiceItem.$inferSelect;

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

export function serializeInvoice(
    invoice: InvoiceRow,
    items: InvoiceItemRow[],
    creditNotes: { id: string; number: string; grossCents: number }[] = [],
) {
    return {
        id: invoice.id,
        customer_id: invoice.customerId,
        contract_id: invoice.contractId,
        number: invoice.number,
        status: invoice.status,
        currency: invoice.currency,
        issued_at: iso(invoice.issuedAt),
        due_at: iso(invoice.dueAt),
        paid_at: iso(invoice.paidAt),
        cancelled_at: iso(invoice.cancelledAt),
        service_period_start: iso(invoice.servicePeriodStart),
        service_period_end: iso(invoice.servicePeriodEnd),
        net_cents: invoice.netCents,
        tax_cents: invoice.taxCents,
        gross_cents: invoice.grossCents,
        credited_cents: invoice.creditedCents,
        tax_strategy: invoice.taxStrategy,
        tax_note: invoice.taxNote,
        recipient: invoice.recipient,
        buyer_reference: invoice.buyerReference,
        intro_text: invoice.introText,
        note: invoice.note,
        items: items.map((item) => ({
            id: item.id,
            position: item.position,
            description: item.description,
            detail: item.detail,
            quantity: item.quantity,
            unit_code: item.unitCode,
            unit_price_cents: item.unitPriceCents,
            net_cents: item.netCents,
            tax_rate_bp: item.taxRateBp,
            tax_category: item.taxCategory,
            tax_rule: item.taxRule,
            service_period_start: iso(item.servicePeriodStart),
            service_period_end: iso(item.servicePeriodEnd),
        })),
        credit_notes: creditNotes.map((entry) => ({
            id: entry.id,
            number: entry.number,
            gross_cents: entry.grossCents,
        })),
        created_at: invoice.createdAt.toISOString(),
        updated_at: invoice.updatedAt.toISOString(),
    };
}

/** The list shape: the document without its positions. */
export function serializeInvoiceSummary(invoice: InvoiceRow) {
    const { items, credit_notes, ...rest } = serializeInvoice(invoice, []);

    return rest;
}
