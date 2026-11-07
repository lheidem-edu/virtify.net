import { zId } from "@/lib/ulid";
import { apiKeyAuth, registry, z } from "../registry";
import { CursorQuerySchema, cursorPage, PROBLEM_RESPONSES } from "../schemas";

/**
 * `/api/v1/invoices`. Rule 11: an endpoint that is not described here is not
 * done — summary, description, tag, schemas with per-field descriptions, the
 * error shapes and the authentication it needs.
 */

const STATUS = z.enum(["draft", "unpaid", "paid", "cancelled"]).openapi({
    description:
        "`draft` hat noch keine Nummer und ist frei änderbar, `unpaid` ist " +
        "ausgestellt und offen, `paid` bezahlt, `cancelled` durch eine " +
        "Rechnungskorrektur vollständig aufgehoben. Ein Kundenschlüssel " +
        "sieht niemals einen Entwurf.",
    example: "unpaid",
});

const TAX_STRATEGY = z
    .string()
    .nullable()
    .openapi({
        description:
            "Die Besteuerung, die beim Ausstellen festgeschrieben wurde — " +
            "`kleinunternehmer` oder `regular-vat`. `null` bei einem Entwurf: " +
            "die Steuer wird erst beim Ausstellen entschieden.",
        example: "kleinunternehmer",
    });

const InvoiceItemSchema = registry.register(
    "InvoiceItem",
    z
        .object({
            id: zId("invoiceitem").openapi({
                description: "Technische ID der Position.",
            }),
            position: z.int().openapi({
                description: "Laufende Nummer auf dem Dokument, ab 1.",
                example: 1,
            }),
            description: z.string().openapi({
                description: "Die Leistung, wie sie auf dem Dokument steht.",
                example: "VPS M — Oktober 2026",
            }),
            detail: z.string().nullable().openapi({
                description: "Kleingedrucktes unter der Position.",
                example: "Vertrag VT-2026-0004",
            }),
            quantity: z.int().openapi({
                description: "Die Menge dieser Position.",
                example: 1,
            }),
            unit_code: z.string().openapi({
                description:
                    "Mengeneinheit nach UN/ECE Recommendation 20 — " +
                    "`MON`, `ANN`, `C62`, `HUR`, `DAY`.",
                example: "MON",
            }),
            unit_price_cents: z.int().openapi({
                description: "Einzelpreis netto, in ganzen Cent.",
                example: 1999,
            }),
            net_cents: z
                .int()
                .nullable()
                .openapi({
                    description:
                        "Menge × Einzelpreis, einmal gerundet und beim Ausstellen " +
                        "festgeschrieben. `null` bei einem Entwurf.",
                    example: 1999,
                }),
            tax_rate_bp: z
                .int()
                .nullable()
                .openapi({
                    description:
                        "Der Steuersatz in Basispunkten — 1900 sind 19 %. Beim " +
                        "Ausstellen festgeschrieben, nie nachträglich ermittelt.",
                    example: 0,
                }),
            tax_category: z
                .string()
                .nullable()
                .openapi({
                    description:
                        "Steuerkategorie nach UNTDID 5305: `S` Regelsatz, " +
                        "`E` steuerbefreit (§ 19 UStG), `AE` Reverse Charge, " +
                        "`O` nicht steuerbar.",
                    example: "E",
                }),
            tax_rule: z
                .string()
                .nullable()
                .openapi({
                    description:
                        "Warum dieser Satz gilt — `kleinunternehmer`, " +
                        "`domestic-standard`, `eu-b2b-reverse-charge`, " +
                        "`eu-b2c-oss` oder `non-eu-out-of-scope`.",
                    example: "kleinunternehmer",
                }),
            service_period_start: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Beginn des Leistungszeitraums dieser Position, " +
                        "falls er vom Dokument abweicht.",
                    example: "2026-10-01T00:00:00.000Z",
                }),
            service_period_end: z.iso.datetime().nullable().openapi({
                description: "Ende des Leistungszeitraums dieser Position.",
                example: "2026-10-31T00:00:00.000Z",
            }),
        })
        .openapi({ description: "Eine Position der Rechnung." }),
);

const InvoiceBase = z.object({
    id: zId("invoice").openapi({
        description: "Technische ID der Rechnung.",
    }),
    customer_id: zId("customer").openapi({
        description: "Das Kundenkonto, an das die Rechnung geht.",
    }),
    contract_id: z.string().nullable().openapi({
        description: "Der Vertrag, zu dem sie gehört, falls es einen gibt.",
        example: null,
    }),
    number: z
        .string()
        .nullable()
        .openapi({
            description:
                "Die fortlaufende Rechnungsnummer nach § 14 Abs. 4 Nr. 4 UStG. " +
                "`null`, solange die Rechnung ein Entwurf ist.",
            example: "RE-2026-0009",
        }),
    status: STATUS,
    currency: z.string().openapi({
        description: "Währung aller Beträge nach ISO 4217.",
        example: "EUR",
    }),
    issued_at: z.iso
        .datetime()
        .nullable()
        .openapi({
            description:
                "Das Rechnungsdatum — und der Zeitpunkt, nach dem sich die " +
                "anzuwendende Besteuerung richtet.",
            example: "2026-11-07T10:00:00.000Z",
        }),
    due_at: z.iso.datetime().nullable().openapi({
        description: "Fälligkeitsdatum.",
        example: "2026-11-21T10:00:00.000Z",
    }),
    paid_at: z.iso.datetime().nullable().openapi({
        description: "Wann die Zahlung eingegangen ist.",
        example: null,
    }),
    cancelled_at: z.iso.datetime().nullable().openapi({
        description: "Wann sie vollständig korrigiert wurde.",
        example: null,
    }),
    service_period_start: z.iso.datetime().nullable().openapi({
        description: "Beginn des Leistungszeitraums des Dokuments.",
        example: "2026-10-01T00:00:00.000Z",
    }),
    service_period_end: z.iso.datetime().nullable().openapi({
        description: "Ende des Leistungszeitraums des Dokuments.",
        example: "2026-10-31T00:00:00.000Z",
    }),
    net_cents: z.int().nullable().openapi({
        description: "Nettosumme in ganzen Cent. `null` bei einem Entwurf.",
        example: 1999,
    }),
    tax_cents: z
        .int()
        .nullable()
        .openapi({
            description:
                "Umsatzsteuer in ganzen Cent, je Steuersatz auf die Summe der " +
                "Positionen gerechnet. Unter § 19 UStG immer 0.",
            example: 0,
        }),
    gross_cents: z.int().nullable().openapi({
        description: "Bruttosumme in ganzen Cent.",
        example: 1999,
    }),
    credited_cents: z.int().openapi({
        description:
            "Was Rechnungskorrekturen von dieser Rechnung zurückgenommen haben.",
        example: 0,
    }),
    tax_strategy: TAX_STRATEGY,
    tax_note: z
        .string()
        .nullable()
        .openapi({
            description:
                "Der steuerliche Hinweis, der auf dem Dokument steht — " +
                "§ 14 Abs. 4 Nr. 8 UStG.",
            example: "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
        }),
    recipient: z
        .string()
        .nullable()
        .openapi({
            description:
                "Die Anschrift, wie sie beim Ausstellen eingefroren wurde, " +
                "eine Zeile je Element.",
            example:
                "Muster GmbH\nMaria Musterfrau\nMusterweg 1\n12345 Musterstadt",
        }),
    buyer_reference: z.string().nullable().openapi({
        description: "Leitweg-ID oder Kundennummer — EN 16931 BT-10.",
        example: "10001",
    }),
    intro_text: z.string().nullable().openapi({
        description: "Einleitender Absatz auf dem Dokument.",
        example: null,
    }),
    note: z.string().nullable().openapi({
        description: "Schlussbemerkung auf dem Dokument.",
        example: null,
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

export const InvoiceSummarySchema = registry.register(
    "InvoiceSummary",
    InvoiceBase.openapi({
        description:
            "Eine Rechnung ohne ihre Positionen, wie sie in Listen steht.",
    }),
);

export const InvoiceSchema = registry.register(
    "Invoice",
    InvoiceBase.extend({
        items: z.array(InvoiceItemSchema).openapi({
            description: "Die Positionen, in Reihenfolge der Positionsnummer.",
        }),
        /**
         * Inlined rather than registered: a `$ref` drops its sibling
         * description, and rule 11 wants one on every field.
         */
        credit_notes: z
            .array(
                z.object({
                    id: zId("creditnote").openapi({
                        description: "Technische ID der Korrektur.",
                    }),
                    number: z.string().openapi({
                        description: "Ihre eigene, lückenlose Nummer.",
                        example: "RK-2026-0001",
                    }),
                    gross_cents: z.int().openapi({
                        description:
                            "Was sie zurücknimmt, in ganzen Cent, positiv.",
                        example: 1999,
                    }),
                }),
            )
            .openapi({
                description:
                    "Die Rechnungskorrekturen zu dieser Rechnung. Eine " +
                    "Korrektur ist ein eigenes Dokument mit eigener Nummer.",
            }),
    }).openapi({
        description:
            "Eine Rechnung mit ihren Positionen. Jede Position trägt die " +
            "Besteuerung, die beim Ausstellen galt — nie die von heute.",
    }),
);

export const InvoicePageSchema = cursorPage(
    InvoiceSummarySchema,
    "InvoicePage",
);

const NewInvoiceItemSchema = registry.register(
    "NewInvoiceItem",
    z
        .object({
            description: z.string().min(1).max(500).openapi({
                description:
                    "Die Leistung, wie sie auf dem Dokument stehen soll.",
                example: "VPS M — Oktober 2026",
            }),
            detail: z.string().max(500).nullish().openapi({
                description: "Kleingedrucktes unter der Position.",
                example: "Vertrag VT-2026-0004",
            }),
            quantity: z
                .int()
                .min(-9999)
                .max(9999)
                .openapi({
                    description:
                        "Die Menge. Negativ für eine Gutschriftsposition; 0 wird " +
                        "abgelehnt statt übergangen.",
                    example: 1,
                }),
            unit_code: z.string().min(1).max(8).default("MON").openapi({
                description: "Mengeneinheit nach UN/ECE Recommendation 20.",
                example: "MON",
            }),
            unit_price_cents: z.int().openapi({
                description: "Einzelpreis netto, in ganzen Cent.",
                example: 1999,
            }),
            service_period_start: z.iso.datetime().nullish().openapi({
                description: "Beginn des Leistungszeitraums dieser Position.",
                example: "2026-10-01T00:00:00.000Z",
            }),
            service_period_end: z.iso.datetime().nullish().openapi({
                description: "Ende des Leistungszeitraums dieser Position.",
                example: "2026-10-31T00:00:00.000Z",
            }),
        })
        .openapi({
            description: "Eine Position eines neuen Rechnungsentwurfs.",
        }),
);

export const NewInvoiceSchema = registry.register(
    "NewInvoice",
    z
        .object({
            customer_id: zId("customer").openapi({
                description: "Das Kundenkonto, an das die Rechnung geht.",
            }),
            contract_id: zId("contract")
                .nullish()
                .openapi({
                    description:
                        "Der Vertrag, zu dem sie gehört. Er muss demselben Konto " +
                        "gehören, sonst wird die Anfrage abgelehnt.",
                }),
            intro_text: z.string().max(2000).nullish().openapi({
                description: "Einleitender Absatz auf dem Dokument.",
                example: null,
            }),
            note: z.string().max(2000).nullish().openapi({
                description: "Schlussbemerkung auf dem Dokument.",
                example: null,
            }),
            service_period_start: z.iso.datetime().nullish().openapi({
                description: "Beginn des Leistungszeitraums des Dokuments.",
                example: "2026-10-01T00:00:00.000Z",
            }),
            service_period_end: z.iso.datetime().nullish().openapi({
                description: "Ende des Leistungszeitraums des Dokuments.",
                example: "2026-10-31T00:00:00.000Z",
            }),
            items: z.array(NewInvoiceItemSchema).min(1).max(200).openapi({
                description: "Mindestens eine Position.",
            }),
        })
        .openapi({
            description:
                "Ein neuer Rechnungsentwurf. Er bekommt keine Nummer und " +
                "keine Steuer — beides entsteht erst beim Ausstellen.",
        }),
);

const SECURITY = [{ [apiKeyAuth.name]: [] }];

const ID_PARAM = z.object({
    id: zId("invoice").openapi({
        param: { name: "id", in: "path" },
        description: "Die technische ID der Rechnung.",
    }),
});

registry.registerPath({
    method: "get",
    path: "/api/v1/invoices",
    tags: ["Rechnungen"],
    summary: "Rechnungen auflisten",
    description:
        "Gibt die Rechnungen seitenweise zurück, sortiert nach ID. Ein " +
        "Kundenschlüssel bekommt ausschließlich die Rechnungen des eigenen " +
        "Kontos und niemals Entwürfe; `customer_id` wird für ihn ignoriert " +
        "statt beachtet. Benötigt `billing.read`.",
    security: SECURITY,
    request: {
        query: CursorQuerySchema.extend({
            status: STATUS.optional().openapi({
                param: { name: "status", in: "query" },
                description: "Auf einen Status einschränken.",
                example: "unpaid",
            }),
            customer_id: z
                .string()
                .optional()
                .openapi({
                    param: { name: "customer_id", in: "query" },
                    description:
                        "Auf ein Kundenkonto einschränken. Nur für " +
                        "Mitarbeiterschlüssel wirksam.",
                    example: "customer_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                }),
        }),
    },
    responses: {
        200: {
            description: "Eine Seite Rechnungen.",
            content: { "application/json": { schema: InvoicePageSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/invoices/{id}",
    tags: ["Rechnungen"],
    summary: "Rechnung ansehen",
    description:
        "Eine Rechnung mit allen Positionen und den Rechnungskorrekturen, die " +
        "auf sie verweisen. Jede Position trägt den Steuersatz, die " +
        "Steuerkategorie und die Regel, die beim Ausstellen galten. Eine " +
        "Rechnung, die dieser Schlüssel nicht sehen darf, wird mit 404 " +
        "beantwortet — ein 403 würde bestätigen, dass es sie gibt. Benötigt " +
        "`billing.read`.",
    security: SECURITY,
    request: { params: ID_PARAM },
    responses: {
        200: {
            description: "Die Rechnung mit ihren Positionen.",
            content: { "application/json": { schema: InvoiceSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/invoices/{id}/pdf",
    tags: ["Rechnungen"],
    summary: "Rechnung als PDF",
    description:
        "Liefert das Dokument selbst. Eine ausgestellte Rechnung kommt Byte " +
        "für Byte aus dem Dokumentenspeicher, so wie sie beim Ausstellen " +
        "gerendert wurde — nicht neu gesetzt. Ein Entwurf wird nur einem " +
        "Mitarbeiterschlüssel ausgeliefert und ist deutlich als solcher " +
        "gekennzeichnet. Benötigt `billing.read`.",
    security: SECURITY,
    request: { params: ID_PARAM },
    responses: {
        200: {
            description: "Das Dokument als PDF.",
            content: {
                "application/pdf": {
                    schema: z.string().openapi({
                        type: "string",
                        format: "binary",
                        description: "Die PDF-Datei.",
                    }),
                },
            },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/invoices",
    tags: ["Rechnungen"],
    summary: "Rechnungsentwurf anlegen",
    description:
        "Legt einen Entwurf an. Ein Entwurf hat keine Nummer, verbraucht " +
        "keine aus der Nummernreihe und trägt noch keine Steuer: beides " +
        "entsteht erst beim Ausstellen. Nur mit einem Mitarbeiterschlüssel — " +
        "eine Rechnung ist eine Zahlungsaufforderung, und ein Kundenschlüssel, " +
        "der eine schreiben könnte, könnte sich selbst abrechnen. Benötigt " +
        "`billing.write`.",
    security: SECURITY,
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: NewInvoiceSchema } },
        },
    },
    responses: {
        201: {
            description: "Der angelegte Entwurf.",
            content: { "application/json": { schema: InvoiceSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/invoices/{id}/finalize",
    tags: ["Rechnungen"],
    summary: "Rechnung ausstellen",
    description:
        "Stellt den Entwurf aus. In einer Transaktion: die Besteuerung, die " +
        "in diesem Moment gilt, wird ermittelt und auf jede Position " +
        "geschrieben, Verkäufer und Käufer werden eingefroren, die Summen " +
        "berechnet und die lückenlose Nummer nach § 14 Abs. 4 Nr. 4 UStG " +
        "vergeben. Danach ist das Dokument unveränderlich — Korrekturen " +
        "erfolgen ausschließlich über eine Rechnungskorrektur. Eine Rechnung, " +
        "die kein Entwurf mehr ist, wird mit 409 abgelehnt statt still " +
        "bestätigt. Nur mit einem Mitarbeiterschlüssel; benötigt " +
        "`billing.write`.",
    security: SECURITY,
    request: { params: ID_PARAM },
    responses: {
        200: {
            description: "Die ausgestellte Rechnung mit Nummer und Summen.",
            content: { "application/json": { schema: InvoiceSchema } },
        },
        409: {
            description:
                "Die Rechnung ist kein Entwurf mehr und kann nicht noch " +
                "einmal ausgestellt werden.",
            content: {
                "application/problem+json": {
                    schema: z.object({
                        type: z.string().openapi({
                            description: "URI die den Fehlertyp benennt.",
                            example:
                                "https://virtify.net/problems/nicht-mehr-aenderbar",
                        }),
                        title: z.string().openapi({
                            description: "Kurze Beschreibung des Fehlertyps.",
                            example: "Nicht mehr änderbar",
                        }),
                        status: z.int().openapi({
                            description: "Der HTTP-Statuscode.",
                            example: 409,
                        }),
                        detail: z.string().openapi({
                            description: "Was in diesem Fall schiefging.",
                            example: "Nur Entwürfe können ausgestellt werden.",
                        }),
                    }),
                },
            },
        },
        ...PROBLEM_RESPONSES,
    },
});
