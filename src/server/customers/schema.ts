import { z } from "zod";

/**
 * One definition of what a customer's master data may be, used by the admin
 * form, the client's profile, the registration and `/api/v1/customers`. A
 * second copy would be a second set of rules, and the API is the one that
 * would quietly end up with the laxer set.
 */

const MAX = 200;

/** Empty strings from a form mean "not given", not "set to empty". */
const optionalText = (max = MAX) =>
    z
        .string()
        .trim()
        .max(max)
        .transform((value) => (value === "" ? null : value))
        .nullable()
        .optional();

export const customerKindSchema = z.enum(["company", "private"]);
export const customerStatusSchema = z.enum(["active", "suspended", "closed"]);

export const customerInputSchema = z.object({
    kind: customerKindSchema.default("private"),
    name: z.string().trim().min(1, "Der Name ist erforderlich.").max(MAX),
    company: optionalText(),
    street: optionalText(),
    postalCode: optionalText(32),
    city: optionalText(),
    /** ISO 3166-1 alpha-2, upper case. */
    country: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, "Zwei Buchstaben nach ISO 3166-1, z. B. DE.")
        .nullable()
        .optional(),
    vatId: optionalText(32),
    phone: optionalText(64),
    buyerReference: optionalText(),
    currency: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/)
        .default("EUR"),
    language: z.enum(["de", "en"]).default("de"),
    status: customerStatusSchema.default("active"),
    notes: optionalText(5000),
});

export type CustomerInput = z.infer<typeof customerInputSchema>;

/** Everything optional, nothing emptied by omission. */
export const customerPatchSchema = customerInputSchema.partial();

export type CustomerPatch = z.infer<typeof customerPatchSchema>;

/**
 * What a customer may change about themselves. Deliberately shorter than the
 * admin's list: status, notes, currency and the customer number are the
 * operator's, and a customer editing their own status would be a free
 * un-suspend.
 */
export const customerSelfPatchSchema = customerInputSchema.pick({
    kind: true,
    name: true,
    company: true,
    street: true,
    postalCode: true,
    city: true,
    country: true,
    vatId: true,
    phone: true,
});

export type CustomerSelfPatch = z.infer<typeof customerSelfPatchSchema>;
