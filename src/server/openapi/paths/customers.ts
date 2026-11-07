import { zId } from "@/lib/ulid";
import { apiKeyAuth, registry, z } from "../registry";
import { CursorQuerySchema, cursorPage, PROBLEM_RESPONSES } from "../schemas";

/**
 * `/api/v1/customers`. Rule 11: an endpoint that is not described here is not
 * done — summary, description, tag, schemas with per-field descriptions, the
 * error shapes and the authentication it needs.
 */

const KIND = z.enum(["company", "private"]).openapi({
    description:
        "`company` für eine Firma, `private` für eine Privatperson. " +
        "Entscheidet über Widerrufsrecht und, sobald die Regelbesteuerung " +
        "aktiv ist, über die Umsatzsteuer.",
    example: "company",
});

const STATUS = z.enum(["active", "suspended", "closed"]).openapi({
    description:
        "`active` im Regelfall, `suspended` wenn Leistungen gesperrt sind, " +
        "`closed` für beendete Konten.",
    example: "active",
});

export const CustomerSchema = registry.register(
    "Customer",
    z.object({
        id: zId("customer").openapi({
            description: "Technische ID des Kundenkontos.",
        }),
        customer_number: z.int().openapi({
            description:
                "Die Kundennummer, wie sie auf Rechnungen und im Schriftverkehr steht.",
            example: 10042,
        }),
        kind: KIND,
        name: z.string().openapi({
            description:
                "Der Rechnungsempfänger: die Firma bei einer Firma, sonst die Person.",
            example: "Maria Musterfrau",
        }),
        company: z.string().nullable().openapi({
            description: "Firmenname, falls vorhanden.",
            example: "Beispiel GmbH",
        }),
        street: z.string().nullable().openapi({
            description: "Straße und Hausnummer.",
            example: "Musterweg 3",
        }),
        postal_code: z.string().nullable().openapi({
            description: "Postleitzahl.",
            example: "48145",
        }),
        city: z.string().nullable().openapi({
            description: "Ort.",
            example: "Münster",
        }),
        country: z.string().nullable().openapi({
            description: "Ländercode nach ISO 3166-1 alpha-2.",
            example: "DE",
        }),
        vat_id: z.string().nullable().openapi({
            description: "Umsatzsteuer-Identifikationsnummer.",
            example: "DE123456789",
        }),
        vat_id_validated_at: z.iso
            .datetime()
            .nullable()
            .openapi({
                description:
                    "Wann die USt-IdNr. zuletzt über VIES bestätigt wurde. " +
                    "`null` heißt: ungeprüft, also keine Grundlage für Reverse-Charge.",
                example: "2026-11-01T09:30:00.000Z",
            }),
        phone: z.string().nullable().openapi({
            description: "Telefonnummer für Rückfragen.",
            example: "+49 251 1234567",
        }),
        buyer_reference: z.string().nullable().openapi({
            description:
                "Käuferreferenz nach EN 16931 (BT-10), bei öffentlichen Auftraggebern die Leitweg-ID.",
            example: "04011000-12345-67",
        }),
        currency: z.string().openapi({
            description: "Währung des Kontos nach ISO 4217.",
            example: "EUR",
        }),
        language: z.enum(["de", "en"]).openapi({
            description: "Sprache für Dokumente und E-Mails.",
            example: "de",
        }),
        status: STATUS,
        notes: z.string().nullable().openapi({
            description:
                "Interne Notiz. Nur für die Verwaltung; ein Kundenschlüssel sieht sie nicht.",
            example: "Zahlt zuverlässig, Rechnung bitte per Post.",
        }),
        created_at: z.iso.datetime().openapi({
            description: "Anlagezeitpunkt in UTC.",
            example: "2026-01-15T10:00:00.000Z",
        }),
        updated_at: z.iso.datetime().openapi({
            description: "Letzte Änderung in UTC.",
            example: "2026-11-07T08:15:00.000Z",
        }),
    }),
);

export const CustomerPageSchema = cursorPage(CustomerSchema, "CustomerPage");

const WRITABLE = {
    kind: KIND.optional(),
    name: z.string().min(1).max(200).openapi({
        description:
            "Der Rechnungsempfänger. Pflichtangabe beim Anlegen eines Kontos.",
        example: "Maria Musterfrau",
    }),
    company: z.string().max(200).nullable().optional().openapi({
        description: "Firmenname, falls vorhanden.",
        example: "Beispiel GmbH",
    }),
    street: z.string().max(200).nullable().optional().openapi({
        description: "Straße und Hausnummer.",
        example: "Musterweg 3",
    }),
    postal_code: z.string().max(32).nullable().optional().openapi({
        description: "Postleitzahl.",
        example: "48145",
    }),
    city: z.string().max(200).nullable().optional().openapi({
        description: "Ort.",
        example: "Münster",
    }),
    country: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .nullable()
        .optional()
        .openapi({
            description: "Ländercode nach ISO 3166-1 alpha-2.",
            example: "DE",
        }),
    vat_id: z.string().max(32).nullable().optional().openapi({
        description:
            "Umsatzsteuer-Identifikationsnummer. Wird beim Speichern nicht geprüft.",
        example: "DE123456789",
    }),
    phone: z.string().max(64).nullable().optional().openapi({
        description: "Telefonnummer für Rückfragen.",
        example: "+49 251 1234567",
    }),
    buyer_reference: z.string().max(200).nullable().optional().openapi({
        description: "Käuferreferenz nach EN 16931 (BT-10).",
        example: "04011000-12345-67",
    }),
    language: z.enum(["de", "en"]).optional().openapi({
        description: "Sprache für Dokumente und E-Mails.",
        example: "de",
    }),
    status: STATUS.optional(),
    notes: z.string().max(5000).nullable().optional().openapi({
        description: "Interne Notiz, nur für die Verwaltung.",
        example: "Rechnung bitte per Post.",
    }),
};

export const CustomerCreateSchema = registry.register(
    "CustomerCreate",
    z.object(WRITABLE).openapi({
        description:
            "Ein neues Kundenkonto. Die Kundennummer wird vergeben, nicht übergeben.",
    }),
);

export const CustomerPatchSchema = registry.register(
    "CustomerPatch",
    z.object({ ...WRITABLE, name: WRITABLE.name.optional() }).openapi({
        description:
            "Nur die mitgeschickten Felder werden geändert. " +
            "`null` leert ein Feld, ein fehlendes Feld lässt es stehen.",
    }),
);

const SECURITY = [{ [apiKeyAuth.name]: [] }];

const ID_PARAM = z.object({
    id: zId("customer").openapi({
        param: { name: "id", in: "path" },
        description: "Die technische ID des Kundenkontos.",
    }),
});

registry.registerPath({
    method: "get",
    path: "/api/v1/customers",
    tags: ["Kunden"],
    summary: "Kundenkonten auflisten",
    description:
        "Gibt die Kundenkonten seitenweise zurück, sortiert nach ID. " +
        "Ein Verwaltungsschlüssel mit `customers.read` sieht alle Konten und " +
        "kann über `q` nach Nummer, Name, Firma oder der Adresse eines " +
        "Kontakts suchen; ein Kundenschlüssel sieht ausschließlich sein eigenes Konto.",
    security: SECURITY,
    request: {
        query: CursorQuerySchema.extend({
            q: z
                .string()
                .optional()
                .openapi({
                    param: { name: "q", in: "query" },
                    description:
                        "Suchbegriff über Kundennummer, Name, Firma und Kontaktadressen.",
                    example: "Beispiel GmbH",
                }),
            status: z
                .enum(["active", "suspended", "closed"])
                .optional()
                .openapi({
                    param: { name: "status", in: "query" },
                    description: "Auf einen Kontostatus einschränken.",
                    example: "active",
                }),
        }),
    },
    responses: {
        200: {
            description: "Eine Seite Kundenkonten.",
            content: { "application/json": { schema: CustomerPageSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/customers",
    tags: ["Kunden"],
    summary: "Kundenkonto anlegen",
    description:
        "Legt ein Kundenkonto ohne Login an — für die Übernahme von Bestandskunden " +
        "und für Konten, die die Verwaltung selbst führt. Die Kundennummer kommt " +
        "aus demselben lückenlosen Zähler wie bei einer Registrierung. " +
        "Benötigt `customers.write`; Kundenschlüssel dürfen das nicht.",
    security: SECURITY,
    request: {
        body: {
            required: true,
            content: {
                "application/json": { schema: CustomerCreateSchema },
            },
        },
    },
    responses: {
        201: {
            description: "Das angelegte Konto.",
            content: { "application/json": { schema: CustomerSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/customers/{id}",
    tags: ["Kunden"],
    summary: "Kundenkonto ansehen",
    description:
        "Ein einzelnes Kundenkonto. Ein Kundenschlüssel darf nur sein eigenes " +
        "abfragen und erhält für jedes andere 404 — nicht 403, was die Existenz " +
        "eines fremden Kontos bestätigen würde.",
    security: SECURITY,
    request: { params: ID_PARAM },
    responses: {
        200: {
            description: "Das Kundenkonto.",
            content: { "application/json": { schema: CustomerSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "patch",
    path: "/api/v1/customers/{id}",
    tags: ["Kunden"],
    summary: "Stammdaten ändern",
    description:
        "Ändert die mitgeschickten Felder und schreibt die Änderung ins " +
        "Protokoll. Benötigt `customers.write`. Ein Kundenschlüssel darf damit " +
        "nur das eigene Konto pflegen und weder `status` noch `notes` setzen.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        body: {
            required: true,
            content: { "application/json": { schema: CustomerPatchSchema } },
        },
    },
    responses: {
        200: {
            description: "Das geänderte Konto.",
            content: { "application/json": { schema: CustomerSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});
