import { z } from "zod";
import type { Customer } from "@/db/schema/customers";
import { customerInputSchema } from "@/server/customers/schema";

/**
 * The translation between the API's wire shape and the service's. The API is
 * snake_case because that is what the specification says; the database rows
 * are camelCase because that is what Drizzle produces. Doing it here once
 * keeps the difference out of both.
 */

export function serializeCustomer(row: Customer) {
    return {
        id: row.id,
        customer_number: row.customerNumber,
        kind: row.kind,
        name: row.name,
        company: row.company,
        street: row.street,
        postal_code: row.postalCode,
        city: row.city,
        country: row.country,
        vat_id: row.vatId,
        vat_id_validated_at: row.vatIdValidatedAt?.toISOString() ?? null,
        phone: row.phone,
        buyer_reference: row.buyerReference,
        currency: row.currency,
        language: row.language as "de" | "en",
        status: row.status,
        notes: row.notes,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
    };
}

/** The same row without what only the operator should see. */
export function serializeForCustomer(row: Customer) {
    const { notes: _notes, ...rest } = serializeCustomer(row);

    return { ...rest, notes: null };
}

const WIRE_TO_FIELD = {
    kind: "kind",
    name: "name",
    company: "company",
    street: "street",
    postal_code: "postalCode",
    city: "city",
    country: "country",
    vat_id: "vatId",
    phone: "phone",
    buyer_reference: "buyerReference",
    language: "language",
    status: "status",
    notes: "notes",
} as const;

/**
 * Accepts the wire body and hands back what the service takes. Unknown keys
 * are dropped rather than rejected: a client that sends `customer_number`
 * should be ignored, not told off, because the field is simply not theirs
 * to set.
 */
export function fromWire(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null) {
        return {};
    }

    const input: Record<string, unknown> = {};

    for (const [wire, field] of Object.entries(WIRE_TO_FIELD)) {
        if (wire in body) {
            input[field] = (body as Record<string, unknown>)[wire];
        }
    }

    return input;
}

/** Creating needs a name; everything else may be filled in later. */
export const createBodySchema = customerInputSchema;

/** Patching changes only what it mentions. */
export const patchBodySchema = customerInputSchema.partial();

/**
 * What a customer's own key may change about itself. `status` and `notes`
 * are missing on purpose — a customer who could set their own status could
 * lift their own suspension.
 */
export const selfPatchBodySchema = customerInputSchema
    .partial()
    .omit({ status: true, notes: true, currency: true });

export const listQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().optional(),
    status: z.enum(["active", "suspended", "closed"]).optional(),
});
