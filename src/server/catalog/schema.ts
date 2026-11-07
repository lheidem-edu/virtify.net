import { z } from "zod";
import { moduleIds } from "@/server/provisioning";

/**
 * One definition of what a catalog row may be, used by the admin forms, the
 * services and `/api/v1`. A second copy would be a second set of rules, and
 * the one that ended up laxer would be the one a price came through.
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

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Ein Kürzel ist erforderlich.")
    .max(80)
    .regex(
        SLUG_PATTERN,
        "Nur Kleinbuchstaben, Ziffern und Bindestriche, z. B. vps-small.",
    );

/** Turns a name into a usable slug, so the form can fill the field itself. */
export function slugify(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

export const billingCycleSchema = z.enum([
    "monthly",
    "quarterly",
    "semiannual",
    "annual",
    "biennial",
    "onetime",
]);

export const productTypeSchema = z.enum([
    "vps",
    "webhosting",
    "gameserver",
    "domain",
    "subscription",
    "other",
]);

export const productStatusSchema = z.enum([
    "draft",
    "active",
    "hidden",
    "retired",
]);

export const configOptionTypeSchema = z.enum([
    "select",
    "checkbox",
    "quantity",
]);

export const couponKindSchema = z.enum(["percent", "fixed"]);
export const couponDurationSchema = z.enum(["once", "repeating", "forever"]);

/** ISO 4217, upper case. */
export const currencySchema = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Drei Buchstaben nach ISO 4217, z. B. EUR.");

/**
 * The currencies the catalog offers. One today, because src/lib/money.ts
 * knows the minor units of exactly one — adding a second means teaching it
 * that currency's exponent first, not widening a list here.
 */
export const CATALOG_CURRENCIES = ["EUR"] as const;

const cents = (label: string) =>
    z
        .number()
        .int(`${label} muss ein ganzer Centbetrag sein.`)
        .min(0, `${label} darf nicht negativ sein.`)
        .max(100_000_000);

export const productGroupInputSchema = z.object({
    slug: slugSchema,
    name: z.string().trim().min(1, "Der Name ist erforderlich.").max(MAX),
    tagline: optionalText(),
    description: optionalText(2000),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    hidden: z.boolean().default(false),
});

export type ProductGroupInput = z.infer<typeof productGroupInputSchema>;

export const productInputSchema = z.object({
    groupId: z.string().trim().min(1, "Eine Gruppe ist erforderlich."),
    slug: slugSchema,
    name: z.string().trim().min(1, "Der Name ist erforderlich.").max(MAX),
    type: productTypeSchema.default("other"),
    status: productStatusSchema.default("draft"),
    tagline: optionalText(),
    description: optionalText(4000),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    module: z
        .string()
        .trim()
        .refine(
            (value) => moduleIds().includes(value),
            "Dieses Bereitstellungsmodul gibt es nicht.",
        )
        .default("none"),
    moduleConfig: z.record(z.string(), z.unknown()).default({}),
    maxQuantity: z.number().int().min(1).max(999).default(1),
});

export type ProductInput = z.infer<typeof productInputSchema>;

/**
 * One cell of the pricing matrix. A cell that is not submitted is not
 * offered — the absence of a row is what "this product is not sold yearly"
 * means, which keeps the matrix a grid of prices rather than a grid of
 * prices plus a grid of switches.
 */
export const productPricingInputSchema = z.object({
    cycle: billingCycleSchema,
    currency: currencySchema,
    priceCents: cents("Der Preis"),
    setupFeeCents: cents("Die Einrichtungsgebühr").default(0),
    trialDays: z.number().int().min(0).max(365).default(0),
});

export type ProductPricingInput = z.infer<typeof productPricingInputSchema>;

export const configOptionInputSchema = z.object({
    name: z.string().trim().min(1, "Der Name ist erforderlich.").max(MAX),
    description: optionalText(1000),
    type: configOptionTypeSchema.default("select"),
    required: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    minQuantity: z.number().int().min(0).max(9999).default(0),
    maxQuantity: z.number().int().min(0).max(9999).default(10),
});

export type ConfigOptionInput = z.infer<typeof configOptionInputSchema>;

export const configOptionValueInputSchema = z.object({
    /** Present when an existing value is being edited. */
    id: z.string().trim().optional(),
    name: z.string().trim().min(1, "Der Name ist erforderlich.").max(MAX),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    isDefault: z.boolean().default(false),
    pricing: z
        .array(
            z.object({
                cycle: billingCycleSchema,
                currency: currencySchema,
                priceCents: cents("Der Preis"),
                setupFeeCents: cents("Die Einrichtungsgebühr").default(0),
            }),
        )
        .default([]),
});

export type ConfigOptionValueInput = z.infer<
    typeof configOptionValueInputSchema
>;

export const couponInputSchema = z
    .object({
        code: z
            .string()
            .trim()
            .toUpperCase()
            .min(3, "Mindestens drei Zeichen.")
            .max(40)
            .regex(
                /^[A-Z0-9._-]+$/,
                "Nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.",
            ),
        description: optionalText(500),
        kind: couponKindSchema,
        /** 2500 is 25 %. */
        percentBasisPoints: z
            .number()
            .int()
            .min(1)
            .max(10_000)
            .nullable()
            .default(null),
        amountCents: cents("Der Betrag").nullable().default(null),
        currency: currencySchema.nullable().default(null),
        duration: couponDurationSchema.default("once"),
        durationPeriods: z
            .number()
            .int()
            .min(1)
            .max(120)
            .nullable()
            .default(null),
        appliesToSetupFee: z.boolean().default(false),
        productIds: z.array(z.string().trim().min(1)).default([]),
        cycles: z.array(billingCycleSchema).default([]),
        validFrom: z.date().nullable().default(null),
        validUntil: z.date().nullable().default(null),
        maxRedemptions: z
            .number()
            .int()
            .min(1)
            .max(1_000_000)
            .nullable()
            .default(null),
        active: z.boolean().default(true),
    })
    .superRefine((value, ctx) => {
        if (value.kind === "percent" && value.percentBasisPoints === null) {
            ctx.addIssue({
                code: "custom",
                path: ["percentBasisPoints"],
                message: "Ein Prozentgutschein braucht einen Prozentsatz.",
            });
        }

        if (value.kind === "fixed" && value.amountCents === null) {
            ctx.addIssue({
                code: "custom",
                path: ["amountCents"],
                message: "Ein Betragsgutschein braucht einen Betrag.",
            });
        }

        if (value.kind === "fixed" && value.currency === null) {
            ctx.addIssue({
                code: "custom",
                path: ["currency"],
                message: "Ein Betragsgutschein braucht eine Währung.",
            });
        }

        if (value.duration === "repeating" && value.durationPeriods === null) {
            ctx.addIssue({
                code: "custom",
                path: ["durationPeriods"],
                message: "Bitte angeben, für wie viele Zeiträume er gilt.",
            });
        }

        if (
            value.validFrom &&
            value.validUntil &&
            value.validFrom > value.validUntil
        ) {
            ctx.addIssue({
                code: "custom",
                path: ["validUntil"],
                message: "Das Ende liegt vor dem Beginn.",
            });
        }
    });

export type CouponInput = z.infer<typeof couponInputSchema>;

/**
 * What the storefront, the checkout and the quote endpoint send: which
 * product, in which cycle and currency, with which add-ons.
 */
export const quoteRequestSchema = z.object({
    cycle: billingCycleSchema,
    currency: currencySchema.default("EUR"),
    quantity: z.number().int().min(1).max(999).default(1),
    options: z
        .array(
            z.object({
                optionId: z.string().trim().min(1),
                valueId: z.string().trim().min(1),
                quantity: z.number().int().min(0).max(9999).default(1),
            }),
        )
        .default([]),
    couponCode: z.string().trim().max(40).nullable().default(null),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
