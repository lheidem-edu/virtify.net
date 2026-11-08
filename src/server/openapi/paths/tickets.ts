import { zId } from "@/lib/ulid";
import { apiKeyAuth, registry, z } from "../registry";
import { CursorQuerySchema, cursorPage, PROBLEM_RESPONSES } from "../schemas";

/**
 * `/api/v1/tickets`. Rule 11: an endpoint that is not described here is not
 * done — summary, description, tag, schemas with per-field descriptions, the
 * error shapes and the authentication it needs.
 */

const SECURITY = [{ [apiKeyAuth.name]: [] }];

const STATUS = z.enum(["open", "waiting", "on_hold", "closed"]).openapi({
    description:
        "`open` wartet auf uns, `waiting` auf den Kunden, `on_hold` ist " +
        "bewusst geparkt — eine Kundenantwort holt ein `on_hold`-Ticket " +
        "absichtlich nicht zurück —, `closed` ist erledigt.",
    example: "open",
});

const PRIORITY = z.enum(["low", "normal", "high", "urgent"]).openapi({
    description: "Dringlichkeit, von der Verwaltung gesetzt.",
    example: "normal",
});

const DIRECTION = z.enum(["inbound", "outbound"]).openapi({
    description:
        "`inbound` kam vom Kunden, `outbound` ging von uns hinaus. " +
        "Interne Notizen stehen nie in dieser Liste.",
    example: "inbound",
});

const AttachmentSchema = registry.register(
    "TicketAttachment",
    z.object({
        id: zId("ticketattachment").openapi({
            description: "Technische ID des Anhangs.",
        }),
        filename: z.string().openapi({
            description: "Der Dateiname, wie er in der Mail stand.",
            example: "screenshot.png",
        }),
        content_type: z.string().openapi({
            description: "MIME-Typ, wie der Absender ihn angegeben hat.",
            example: "image/png",
        }),
        size_bytes: z.int().openapi({
            description: "Größe der gespeicherten Datei in Byte.",
            example: 48210,
        }),
        inline: z.boolean().openapi({
            description:
                "Ob der Anhang im Text eingebettet war (`cid:`) statt angehängt.",
            example: false,
        }),
    }),
);

const MessageSchema = registry.register(
    "TicketMessage",
    z.object({
        id: zId("ticketmessage").openapi({
            description: "Technische ID der Nachricht.",
        }),
        direction: DIRECTION,
        author_type: z.enum(["customer", "staff", "system"]).openapi({
            description:
                "Wer geschrieben hat. `system` sind automatische Nachrichten, " +
                "etwa die Eingangsbestätigung.",
            example: "customer",
        }),
        author_name: z.string().nullable().openapi({
            description: "Angezeigter Name des Absenders, falls bekannt.",
            example: "Maria Musterfrau",
        }),
        author_email: z.string().nullable().openapi({
            description: "Absenderadresse der Nachricht.",
            example: "maria@example.net",
        }),
        body: z.string().openapi({
            description:
                "Der Text der Nachricht ohne zitierte Vorgeschichte und ohne " +
                "Signatur. Das Original bleibt gespeichert und ist in der " +
                "Verwaltung einsehbar; über die Schnittstelle wird es nicht " +
                "ausgeliefert.",
            example: "Mein Server ist seit heute Morgen nicht erreichbar.",
        }),
        automated: z.boolean().openapi({
            description:
                "Ob die Nachricht maschinell erzeugt wirkte (Auto-Submitted, " +
                "Abwesenheitsnotiz). Auf solche Nachrichten wird nie " +
                "automatisch geantwortet.",
            example: false,
        }),
        sent_at: z.iso.datetime().openapi({
            description: "Zeitpunkt der Nachricht, UTC.",
            example: "2026-11-08T09:14:00.000Z",
        }),
        attachments: z.array(AttachmentSchema).openapi({
            description: "Die gespeicherten Anhänge dieser Nachricht.",
        }),
    }),
);

const TicketRowSchema = registry.register(
    "TicketSummary",
    z.object({
        id: zId("ticket").openapi({
            description: "Technische ID des Tickets.",
        }),
        number: z.int().openapi({
            description: "Die fortlaufende Ticketnummer.",
            example: 42,
        }),
        reference: z.string().openapi({
            description:
                "Die Nummer, wie sie im Betreff steht. Bleibt sie beim " +
                "Antworten erhalten, landet die Antwort wieder im selben Ticket.",
            example: "TKT-00042",
        }),
        subject: z.string().openapi({
            description: "Der Betreff des Tickets.",
            example: "Server nicht erreichbar",
        }),
        status: STATUS,
        priority: PRIORITY,
        department: z.string().openapi({
            description: "Die Abteilung, in deren Postfach das Ticket liegt.",
            example: "Support",
        }),
        customer_id: zId("customer")
            .nullable()
            .openapi({
                description:
                    "Das zugeordnete Kundenkonto, oder `null`, wenn der Absender " +
                    "keinem Kontakt zugeordnet werden konnte.",
            }),
        customer_name: z.string().nullable().openapi({
            description: "Name des Kundenkontos.",
            example: "Beispiel GmbH",
        }),
        assignee: z.string().nullable().openapi({
            description: "Die zuständige Mitarbeiterin, falls zugewiesen.",
            example: "Luca",
        }),
        unknown_sender: z.boolean().openapi({
            description:
                "Ob der Absender keinem Kontakt zugeordnet werden konnte. " +
                "Solche Tickets sind ausschließlich für die Verwaltung sichtbar.",
            example: false,
        }),
        requester_email: z.string().openapi({
            description: "Die Adresse, von der die erste Nachricht kam.",
            example: "maria@example.net",
        }),
        message_count: z.int().openapi({
            description:
                "Anzahl der Nachrichten einschließlich interner Notizen.",
            example: 3,
        }),
        last_message_at: z.iso.datetime().openapi({
            description: "Zeitpunkt der letzten Nachricht, UTC.",
            example: "2026-11-08T09:14:00.000Z",
        }),
        created_at: z.iso.datetime().openapi({
            description: "Wann das Ticket eröffnet wurde, UTC.",
            example: "2026-11-08T08:02:00.000Z",
        }),
        merged_into: zId("ticket")
            .nullable()
            .openapi({
                description:
                    "Gesetzt, wenn dieses Ticket in ein anderes zusammengeführt " +
                    "wurde. Die Nummer bleibt gültig und führt zum Ziel-Ticket.",
            }),
    }),
);

const TicketSchema = registry.register(
    "Ticket",
    TicketRowSchema.omit({ message_count: true }).extend({
        requester_name: z.string().nullable().openapi({
            description: "Name des Absenders, falls die Mail einen trug.",
            example: "Maria Musterfrau",
        }),
        service_id: zId("service").nullable().openapi({
            description: "Die Leistung, um die es geht, falls verknüpft.",
        }),
        invoice_id: zId("invoice").nullable().openapi({
            description: "Die Rechnung, um die es geht, falls verknüpft.",
        }),
        merged_in: z
            .array(
                z.object({
                    id: zId("ticket").openapi({
                        description: "Das zusammengeführte Ticket.",
                    }),
                    number: z.int().openapi({
                        description: "Dessen Nummer.",
                        example: 41,
                    }),
                    reference: z.string().openapi({
                        description: "Dessen Nummer im Betreffformat.",
                        example: "TKT-00041",
                    }),
                }),
            )
            .openapi({
                description: "Tickets, die in dieses zusammengeführt wurden.",
            }),
        first_response_at: z.iso.datetime().nullable().openapi({
            description: "Wann zum ersten Mal geantwortet wurde, UTC.",
            example: "2026-11-08T09:40:00.000Z",
        }),
        closed_at: z.iso.datetime().nullable().openapi({
            description: "Wann das Ticket geschlossen wurde, UTC.",
            example: "2026-11-09T11:00:00.000Z",
        }),
        messages: z.array(MessageSchema).openapi({
            description:
                "Die Unterhaltung, älteste zuerst. Interne Notizen sind nie " +
                "enthalten — auch nicht für einen Verwaltungsschlüssel.",
        }),
    }),
);

const TicketPageSchema = cursorPage(TicketRowSchema, "TicketPage");

const TicketCreateSchema = registry.register(
    "TicketCreate",
    z.object({
        customer_id: zId("customer")
            .nullish()
            .openapi({
                description:
                    "Für welches Konto das Ticket eröffnet wird. Bei einem " +
                    "Kundenschlüssel wird das Feld ignoriert und das eigene " +
                    "Konto verwendet.",
            }),
        department_id: zId("ticketdepartment").nullish().openapi({
            description:
                "Die Abteilung. Ohne Angabe die als Standard markierte.",
        }),
        subject: z.string().min(1).max(200).openapi({
            description: "Der Betreff.",
            example: "Server nicht erreichbar",
        }),
        message: z.string().min(1).max(20_000).openapi({
            description: "Die erste Nachricht.",
            example: "Seit heute Morgen antwortet der Server nicht mehr.",
        }),
        priority: PRIORITY.default("normal"),
        requester_email: z
            .email()
            .nullish()
            .openapi({
                description:
                    "Die Absenderadresse. Nur für einen Verwaltungsschlüssel; " +
                    "bei einem Kundenschlüssel wird sie aus den Kontakten des " +
                    "Kontos genommen, damit kein Ticket in fremdem Namen " +
                    "eröffnet werden kann.",
                example: "maria@example.net",
            }),
        requester_name: z.string().max(120).nullish().openapi({
            description: "Name des Absenders.",
            example: "Maria Musterfrau",
        }),
        service_id: zId("service").nullish().openapi({
            description:
                "Verknüpfte Leistung. Nur für einen Verwaltungsschlüssel.",
        }),
        invoice_id: zId("invoice").nullish().openapi({
            description:
                "Verknüpfte Rechnung. Nur für einen Verwaltungsschlüssel.",
        }),
    }),
);

const TicketMessageCreateSchema = registry.register(
    "TicketMessageCreate",
    z.object({
        message: z.string().min(1).max(20_000).openapi({
            description: "Der Text der Nachricht.",
            example: "Danke, der Server läuft wieder.",
        }),
        close: z.boolean().default(false).openapi({
            description: "Ob das Ticket mit dieser Nachricht geschlossen wird.",
            example: false,
        }),
    }),
);

const ID_PARAM = z.object({
    id: zId("ticket").openapi({
        param: { name: "id", in: "path" },
        description: "Die technische ID des Tickets.",
    }),
});

registry.registerPath({
    method: "get",
    path: "/api/v1/tickets",
    tags: ["Tickets"],
    summary: "Tickets auflisten",
    description:
        "Gibt die Tickets seitenweise zurück, neueste zuerst. Ein " +
        "Kundenschlüssel sieht ausschließlich die Tickets des eigenen Kontos; " +
        "`customer_id` wird für ihn ignoriert statt beachtet. Tickets ohne " +
        "zugeordnetes Konto — unbekannter Absender — sind nur für einen " +
        "Verwaltungsschlüssel sichtbar. Benötigt `tickets.read`.",
    security: SECURITY,
    request: {
        query: CursorQuerySchema.extend({
            status: z
                .enum(["open", "waiting", "on_hold", "closed", "open-ish"])
                .optional()
                .openapi({
                    param: { name: "status", in: "query" },
                    description:
                        "Auf einen Status einschränken. `open-ish` fasst alles " +
                        "zusammen, was nicht geschlossen ist.",
                    example: "open",
                }),
            priority: z
                .enum(["low", "normal", "high", "urgent"])
                .optional()
                .openapi({
                    param: { name: "priority", in: "query" },
                    description: "Auf eine Dringlichkeit einschränken.",
                    example: "high",
                }),
            customer_id: zId("customer")
                .optional()
                .openapi({
                    param: { name: "customer_id", in: "query" },
                    description:
                        "Nur für einen Verwaltungsschlüssel: auf ein Konto " +
                        "einschränken.",
                }),
        }),
    },
    responses: {
        200: {
            description: "Eine Seite Tickets.",
            content: { "application/json": { schema: TicketPageSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/tickets",
    tags: ["Tickets"],
    summary: "Ticket eröffnen",
    description:
        "Eröffnet ein Ticket mit einer ersten Nachricht. Es wird dabei nichts " +
        "versendet — die Nachricht steht in der Warteschlange der Abteilung. " +
        "Benötigt `tickets.write`.",
    security: SECURITY,
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: TicketCreateSchema } },
        },
    },
    responses: {
        201: {
            description: "Das eröffnete Ticket.",
            content: { "application/json": { schema: TicketSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/tickets/{id}",
    tags: ["Tickets"],
    summary: "Ticket ansehen",
    description:
        "Ein Ticket mit seiner vollständigen Unterhaltung, interne Notizen " +
        "ausgenommen. Ein Ticket, das dieser Schlüssel nicht sehen darf, " +
        "beantwortet sich mit 404 und nicht mit 403 — eine Ticketnummer ist " +
        "kurz und ratbar, und 403 würde bestätigen, dass es sie gibt. " +
        "Benötigt `tickets.read`.",
    security: SECURITY,
    request: { params: ID_PARAM },
    responses: {
        200: {
            description: "Das Ticket.",
            content: { "application/json": { schema: TicketSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/tickets/{id}/messages",
    tags: ["Tickets"],
    summary: "Auf ein Ticket antworten",
    description:
        "Fügt dem Ticket eine Nachricht hinzu. Mit einem Kundenschlüssel ist " +
        "das die Antwort des Kunden; sie wird nicht versendet, sondern der " +
        "Verwaltung vorgelegt. Mit einem Verwaltungsschlüssel geht die " +
        "Antwort über das Postfach der Abteilung hinaus — an die Empfänger, " +
        "die das Ticket bereits kennt, und an niemanden, den die Anfrage " +
        "benennt. Ohne angebundenes Postfach wird sie mit 503 abgelehnt statt " +
        "als versendet verbucht. Benötigt `tickets.reply`.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        body: {
            required: true,
            content: {
                "application/json": { schema: TicketMessageCreateSchema },
            },
        },
    },
    responses: {
        201: {
            description: "Das Ticket mit der neuen Nachricht.",
            content: { "application/json": { schema: TicketSchema } },
        },
        503: {
            description:
                "Es ist kein Mail-Kanal eingerichtet, über den die Antwort " +
                "hinausgehen könnte.",
            content: {
                "application/problem+json": {
                    schema: z.object({}).openapi({
                        description: "RFC-9457-Problem.",
                    }),
                },
            },
        },
        ...PROBLEM_RESPONSES,
    },
});
