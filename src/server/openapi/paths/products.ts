import { zId } from "@/lib/ulid";
import { apiKeyAuth, registry, z } from "../registry";
import { CursorQuerySchema, cursorPage, PROBLEM_RESPONSES } from "../schemas";

/**
 * `/api/v1/products`. Rule 11: an endpoint that is not described here is not
 * done — summary, description, tag, schemas with per-field descriptions, the
 * error shapes and the authentication it needs.
 */

const CYCLE = z
    .enum([
        "monthly",
        "quarterly",
        "semiannual",
        "annual",
        "biennial",
        "onetime",
    ])
    .openapi({
        description:
            "Der Abrechnungszeitraum. `onetime` ist ein einmaliger Verkauf " +
            "ohne Verlängerung und ohne Testphase.",
        example: "monthly",
    });

const PRODUCT_TYPE = z
    .enum([
        "vps",
        "webhosting",
        "gameserver",
        "domain",
        "subscription",
        "other",
    ])
    .openapi({
        description:
            "Die Art des Produkts. `subscription` ist ein rein wiederkehrendes " +
            "Produkt ohne Bereitstellung — Supportvertrag, Managed Service, Lizenz.",
        example: "vps",
    });

const PRODUCT_STATUS = z
    .enum(["draft", "active", "hidden", "retired"])
    .openapi({
        description:
            "`draft` ist in Vorbereitung, `active` wird im Shop gelistet, " +
            "`hidden` ist nur über den direkten Link bestellbar, `retired` " +
            "wird nicht mehr verkauft.",
        example: "active",
    });

const PricingSchema = registry.register(
    "ProductPricing",
    z
        .object({
            cycle: CYCLE,
            currency: z.string().openapi({
                description: "Währung dieser Zelle nach ISO 4217.",
                example: "EUR",
            }),
            price_cents: z.int().openapi({
                description:
                    "Laufender Preis für einen Zeitraum, in ganzen Cent.",
                example: 1999,
            }),
            setup_fee_cents: z.int().openapi({
                description: "Einmalige Einrichtungsgebühr, in ganzen Cent.",
                example: 1000,
            }),
            trial_days: z.int().openapi({
                description:
                    "Freie Tage vor der ersten laufenden Abrechnung. " +
                    "`0` heißt: sofort. Die Einrichtungsgebühr wird auch " +
                    "während einer Testphase sofort berechnet.",
                example: 0,
            }),
        })
        .openapi({
            description:
                "Eine Zelle der Preismatrix: ein Produkt × ein Zeitraum × eine Währung. " +
                "Fehlt die Zelle, wird das Produkt so nicht angeboten.",
        }),
);

/**
 * Deliberately not registered as a component of its own: a `$ref` carries no
 * description, and rule 11 wants one on every field. Inlined, the field keeps
 * the sentence that says what it is.
 */
const GroupRefSchema = z
    .object({
        id: zId("productgroup").openapi({
            description: "Technische ID der Produktgruppe.",
        }),
        slug: z.string().openapi({
            description: "Kürzel der Gruppe, wie es in der URL steht.",
            example: "vps",
        }),
        name: z.string().openapi({
            description: "Anzeigename der Gruppe.",
            example: "KVM-Instanzen",
        }),
    })
    .openapi({ description: "Die Gruppe, unter der das Produkt steht." });

const ProductBase = z.object({
    id: zId("product").openapi({
        description: "Technische ID des Produkts.",
    }),
    slug: z.string().openapi({
        description: "Kürzel des Produkts, wie es in der URL steht.",
        example: "vps-m",
    }),
    name: z.string().openapi({
        description: "Anzeigename des Produkts.",
        example: "VPS M",
    }),
    type: PRODUCT_TYPE,
    status: PRODUCT_STATUS,
    tagline: z.string().nullable().openapi({
        description: "Eine Zeile unter dem Namen.",
        example: "4 vCPU, 8 GB RAM, 160 GB NVMe",
    }),
    description: z.string().nullable().openapi({
        description: "Ausführliche Beschreibung für die Produktseite.",
        example: "KVM-Instanz auf eigener Hardware, mit eigenen IP-Adressen.",
    }),
    module: z.string().openapi({
        description:
            "Das Bereitstellungsmodul, das bei einer Bestellung läuft. " +
            "`none` heißt: es wird nur abgerechnet.",
        example: "none",
    }),
    max_quantity: z.int().openapi({
        description: "Wie viele davon eine einzelne Bestellung nehmen darf.",
        example: 1,
    }),
    group: GroupRefSchema,
    pricing: z.array(PricingSchema).openapi({
        description: "Die Preismatrix dieses Produkts.",
    }),
    created_at: z.iso.datetime().openapi({
        description: "Anlagezeitpunkt in UTC.",
        example: "2026-11-01T09:00:00.000Z",
    }),
    updated_at: z.iso.datetime().openapi({
        description: "Letzte Änderung in UTC.",
        example: "2026-11-07T08:15:00.000Z",
    }),
});

export const ProductSchema = registry.register("Product", ProductBase);

export const ProductPageSchema = cursorPage(ProductSchema, "ProductPage");

const ConfigOptionValueSchema = registry.register(
    "ConfigOptionValue",
    z
        .object({
            id: zId("configoptionvalue").openapi({
                description: "Technische ID des Wertes.",
            }),
            name: z.string().openapi({
                description: "Anzeigename des Wertes.",
                example: "+8 GB",
            }),
            is_default: z.boolean().openapi({
                description: "Ob dieser Wert im Shop vorausgewählt ist.",
                example: false,
            }),
            pricing: z
                .array(
                    z.object({
                        cycle: CYCLE,
                        currency: z.string().openapi({
                            description: "Währung dieser Zelle nach ISO 4217.",
                            example: "EUR",
                        }),
                        price_cents: z.int().openapi({
                            description:
                                "Aufpreis je Einheit und Zeitraum, in ganzen Cent.",
                            example: 500,
                        }),
                        setup_fee_cents: z.int().openapi({
                            description:
                                "Einmalige Einrichtungsgebühr je Einheit, in ganzen Cent.",
                            example: 0,
                        }),
                    }),
                )
                .openapi({
                    description:
                        "Der Aufpreis je Zeitraum und Währung. Fehlt eine Zelle, " +
                        "ist der Wert in diesem Zeitraum kostenlos.",
                }),
        })
        .openapi({ description: "Ein wählbarer Wert einer Option." }),
);

const ConfigOptionSchema = registry.register(
    "ConfigOption",
    z
        .object({
            id: zId("configoption").openapi({
                description: "Technische ID der Option.",
            }),
            name: z.string().openapi({
                description: "Anzeigename der Option.",
                example: "Arbeitsspeicher",
            }),
            description: z.string().nullable().openapi({
                description: "Erklärung unter der Option.",
                example: "Zusätzlicher RAM, jederzeit änderbar.",
            }),
            type: z.enum(["select", "checkbox", "quantity"]).openapi({
                description:
                    "`select`: genau einer der Werte. `checkbox`: ein Wert, " +
                    "an oder aus. `quantity`: ein Wert, je Einheit berechnet.",
                example: "select",
            }),
            required: z.boolean().openapi({
                description: "Ob die Option beantwortet werden muss.",
                example: false,
            }),
            min_quantity: z.int().openapi({
                description:
                    "Kleinste Stückzahl bei `quantity`; sonst ohne Bedeutung.",
                example: 0,
            }),
            max_quantity: z.int().openapi({
                description:
                    "Größte Stückzahl bei `quantity`; sonst ohne Bedeutung.",
                example: 8,
            }),
            values: z.array(ConfigOptionValueSchema).openapi({
                description: "Die wählbaren Werte, in Anzeigereihenfolge.",
            }),
        })
        .openapi({
            description: "Eine konfigurierbare Zusatzleistung des Produkts.",
        }),
);

export const ProductDetailSchema = registry.register(
    "ProductDetail",
    ProductBase.extend({
        config_options: z.array(ConfigOptionSchema).openapi({
            description: "Die Zusatzleistungen, die dieses Produkt anbietet.",
        }),
    }).openapi({
        description: "Ein Produkt mit seiner Preismatrix und seinen Optionen.",
    }),
);

export const QuoteRequestSchema = registry.register(
    "QuoteRequest",
    z
        .object({
            cycle: CYCLE,
            currency: z.string().default("EUR").openapi({
                description: "Währung nach ISO 4217.",
                example: "EUR",
            }),
            quantity: z.int().min(1).max(999).default(1).openapi({
                description: "Wie viele Einheiten des Produkts.",
                example: 1,
            }),
            options: z
                .array(
                    z.object({
                        option_id: zId("configoption").openapi({
                            description: "Welche Option gewählt wurde.",
                        }),
                        value_id: zId("configoptionvalue").openapi({
                            description: "Welcher Wert dieser Option.",
                        }),
                        quantity: z
                            .int()
                            .min(0)
                            .max(9999)
                            .default(1)
                            .openapi({
                                description:
                                    "Einheiten bei `quantity`-Optionen. Bei " +
                                    "`select` immer 1, bei `checkbox` 0 oder 1.",
                                example: 1,
                            }),
                    }),
                )
                .default([])
                .openapi({
                    description:
                        "Die gewählten Zusatzleistungen. Eine Option, die es " +
                        "nicht gibt, wird abgelehnt statt übergangen.",
                }),
            coupon_code: z.string().nullable().default(null).openapi({
                description:
                    "Ein Gutscheincode. Groß- und Kleinschreibung spielt keine Rolle.",
                example: "WILLKOMMEN",
            }),
        })
        .openapi({
            description:
                "Was angeboten werden soll: Produkt, Zeitraum, Menge, Optionen, Gutschein.",
        }),
);

const QuoteLineSchema = registry.register(
    "QuoteLine",
    z
        .object({
            kind: z.enum(["base", "option", "setup", "discount"]).openapi({
                description:
                    "`base` der Grundpreis, `option` eine Zusatzleistung, " +
                    "`setup` eine einmalige Einrichtung, `discount` ein Gutschein.",
                example: "base",
            }),
            label: z.string().openapi({
                description: "Die Bezeichnung der Position.",
                example: "VPS M",
            }),
            detail: z.string().nullable().openapi({
                description: "Kleingedrucktes unter der Position.",
                example: "monatlich",
            }),
            quantity: z.int().openapi({
                description: "Die Stückzahl dieser Position.",
                example: 1,
            }),
            unit_amount_cents: z.int().openapi({
                description:
                    "Einzelpreis in ganzen Cent; bei einem Gutschein negativ.",
                example: 1999,
            }),
            amount_cents: z.int().openapi({
                description: "Gesamtbetrag der Position in ganzen Cent.",
                example: 1999,
            }),
            recurring: z.boolean().openapi({
                description:
                    "`true`: in jedem Zeitraum. `false`: einmalig zu Beginn.",
                example: true,
            }),
            option_id: z.string().nullable().openapi({
                description:
                    "Die Option, aus der die Position stammt, falls es eine gibt.",
                example: null,
            }),
            value_id: z.string().nullable().openapi({
                description:
                    "Der gewählte Wert, falls die Position aus einer Option stammt.",
                example: null,
            }),
        })
        .openapi({ description: "Eine Position der Preisaufstellung." }),
);

/** Inlined for the same reason as `GroupRefSchema` above. */
const QuoteTotalsSchema = z
    .object({
        currency: z.string().openapi({
            description: "Währung aller Beträge nach ISO 4217.",
            example: "EUR",
        }),
        cycle: CYCLE,
        recurring_gross_cents: z.int().openapi({
            description:
                "Grundpreis und Optionen für einen Zeitraum, vor Gutschein.",
            example: 2799,
        }),
        recurring_discount_cents: z.int().openapi({
            description: "Was der Gutschein von einem Zeitraum abzieht.",
            example: 280,
        }),
        first_period_cents: z.int().openapi({
            description: "Was ein Zeitraum kostet, solange der Gutschein gilt.",
            example: 2519,
        }),
        renewal_cents: z.int().openapi({
            description:
                "Was ein Zeitraum kostet, sobald er nicht mehr gilt. " +
                "`0` bei einem einmaligen Verkauf.",
            example: 2799,
        }),
        setup_gross_cents: z.int().openapi({
            description: "Einrichtungsgebühren vor Gutschein.",
            example: 1400,
        }),
        setup_discount_cents: z.int().openapi({
            description:
                "Was der Gutschein von der Einrichtung abzieht — nur, wenn er das darf.",
            example: 0,
        }),
        setup_cents: z.int().openapi({
            description: "Einrichtungsgebühren nach Gutschein.",
            example: 1400,
        }),
        due_today_cents: z.int().openapi({
            description:
                "Was bei der Bestellung fällig wird. Eine Testphase " +
                "verschiebt den Zeitraum, nicht die Einrichtung.",
            example: 3919,
        }),
        trial_days: z.int().openapi({
            description: "Freie Tage vor der ersten laufenden Abrechnung.",
            example: 0,
        }),
        first_charge_at: z.iso
            .datetime()
            .nullable()
            .openapi({
                description:
                    "Wann die erste laufende Abrechnung fällig wird; " +
                    "`null` bei einem einmaligen Verkauf.",
                example: "2026-11-07T10:00:00.000Z",
            }),
        discount_periods: z
            .int()
            .nullable()
            .openapi({
                description:
                    "Für wie viele Zeiträume der Gutschein gilt. " +
                    "`null` heißt dauerhaft, `0` heißt: keiner angewandt.",
                example: 1,
            }),
    })
    .openapi({
        description:
            "Die Summen. Alle Beträge sind ganzzahlige Cent in `currency`.",
    });

export const QuoteSchema = registry.register(
    "Quote",
    z
        .object({
            product_id: zId("product").openapi({
                description: "Das Produkt, für das gerechnet wurde.",
            }),
            product_name: z.string().openapi({
                description: "Sein Name zum Zeitpunkt der Berechnung.",
                example: "VPS M",
            }),
            lines: z.array(QuoteLineSchema).openapi({
                description: "Die Aufstellung, Position für Position.",
            }),
            totals: QuoteTotalsSchema,
            coupon: z
                .object({
                    id: zId("coupon").openapi({
                        description: "Technische ID des Gutscheins.",
                    }),
                    code: z.string().openapi({
                        description: "Der Code, wie er gespeichert ist.",
                        example: "WILLKOMMEN",
                    }),
                    label: z.string().openapi({
                        description: "Was er wert ist, in Worten.",
                        example: "25 %",
                    }),
                })
                .nullable()
                .openapi({
                    description: "Der angewandte Gutschein, sonst `null`.",
                }),
            coupon_error: z
                .string()
                .nullable()
                .openapi({
                    description:
                        "Warum ein übergebener Code nicht angewandt wurde. " +
                        "Deutsch, zur Anzeige für den Kunden.",
                    example: "Dieser Gutscheincode ist abgelaufen.",
                }),
        })
        .openapi({
            description:
                "Ein Preisangebot. Dieselbe Funktion rechnet den Shop-Preis, " +
                "die Kasse und diese Antwort — ein angezeigter Preis kann " +
                "einem berechneten nicht widersprechen.",
        }),
);

const SECURITY = [{ [apiKeyAuth.name]: [] }];

const ID_PARAM = z.object({
    id: zId("product").openapi({
        param: { name: "id", in: "path" },
        description:
            "Die technische ID des Produkts. Das Kürzel (`slug`) wird " +
            "ebenfalls angenommen.",
    }),
});

registry.registerPath({
    method: "get",
    path: "/api/v1/products",
    tags: ["Katalog"],
    summary: "Produkte auflisten",
    description:
        "Gibt die verkäuflichen Produkte seitenweise zurück, sortiert nach ID, " +
        "jeweils mit ihrer Preismatrix. Entwürfe und eingestellte Produkte " +
        "sind nicht dabei. Benötigt `catalog.read`; ein Kundenschlüssel darf " +
        "das ebenfalls, denn der Katalog ist das, woraus bestellt wird.",
    security: SECURITY,
    request: {
        query: CursorQuerySchema.extend({
            q: z
                .string()
                .optional()
                .openapi({
                    param: { name: "q", in: "query" },
                    description: "Suchbegriff über Name, Kürzel und Zeile.",
                    example: "vps",
                }),
            group: z
                .string()
                .optional()
                .openapi({
                    param: { name: "group", in: "query" },
                    description:
                        "Auf eine Produktgruppe einschränken — ID oder Kürzel.",
                    example: "vps",
                }),
            type: PRODUCT_TYPE.optional().openapi({
                param: { name: "type", in: "query" },
                description: "Auf eine Produktart einschränken.",
                example: "vps",
            }),
        }),
    },
    responses: {
        200: {
            description: "Eine Seite Produkte.",
            content: { "application/json": { schema: ProductPageSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/products/{id}",
    tags: ["Katalog"],
    summary: "Produkt ansehen",
    description:
        "Ein einzelnes Produkt mit seiner Preismatrix und allen Zusatzleistungen, " +
        "die es anbietet — alles, was eine Bestellung braucht. Entwürfe und " +
        "eingestellte Produkte werden mit 404 beantwortet. Benötigt `catalog.read`.",
    security: SECURITY,
    request: { params: ID_PARAM },
    responses: {
        200: {
            description: "Das Produkt mit Preisen und Optionen.",
            content: { "application/json": { schema: ProductDetailSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/products/{id}/quote",
    tags: ["Katalog"],
    summary: "Preis berechnen",
    description:
        "Rechnet aus, was eine Bestellung kosten würde: Grundpreis, " +
        "Zusatzleistungen, Einrichtung, Testphase und Gutschein, als Aufstellung " +
        "und als Summen. Es ist dieselbe Funktion, die den Preis im Shop anzeigt " +
        "und die Kasse abrechnet, deshalb kann die Antwort der späteren Rechnung " +
        "nicht widersprechen. Nichts wird dabei gespeichert; ein Gutscheincode " +
        "wird geprüft, aber nicht eingelöst. Benötigt `catalog.read`.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        body: {
            required: true,
            content: { "application/json": { schema: QuoteRequestSchema } },
        },
    },
    responses: {
        200: {
            description: "Die Preisaufstellung.",
            content: { "application/json": { schema: QuoteSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});
