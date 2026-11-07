import { zId } from "@/lib/ulid";
import { apiKeyAuth, registry, z } from "../registry";
import {
    CursorQuerySchema,
    cursorPage,
    PROBLEM_RESPONSES,
    ProblemSchema,
} from "../schemas";

/**
 * `/api/v1/transactions` and `/api/v1/invoices/{id}/payments`. Rule 11: an
 * endpoint that is not described here is not done — summary, description,
 * tag, schemas with per-field descriptions, the error shapes and the
 * authentication it needs.
 */

const SECURITY = [{ [apiKeyAuth.name]: [] }];

const GATEWAY = z
    .enum(["stripe", "paypal", "banktransfer", "credit"])
    .openapi({
        description:
            "Wer das Geld bewegt hat. `banktransfer` ist eine von Hand " +
            "verbuchte Überweisung, `credit` ist Guthaben des Kontos, das " +
            "auf eine Rechnung angerechnet wurde.",
        example: "stripe",
    });

const STATUS = z
    .enum(["pending", "processing", "succeeded", "failed", "refunded"])
    .openapi({
        description:
            "`pending` ist begonnen und noch nicht beim Anbieter " +
            "abgeschlossen, `processing` angenommen aber noch kein Geld " +
            "(eine SEPA-Lastschrift braucht Tage), `succeeded` eingegangen, " +
            "`failed` abgelehnt, `refunded` vollständig zurückgezahlt. Eine " +
            "nur teilweise erstattete Zahlung bleibt `succeeded` und führt " +
            "den Betrag in `refunded_cents`.",
        example: "succeeded",
    });

const KIND = z.enum(["charge", "refund"]).openapi({
    description:
        "In welche Richtung das Geld floss. Eine Erstattung ist eine eigene " +
        "Zeile mit eigenem Betrag, die auf die Zahlung zeigt, die sie " +
        "zurücknimmt — kein Status auf jener Zeile.",
    example: "charge",
});

const TransactionBase = z.object({
    id: zId("payment").openapi({
        description: "Technische ID des Vorgangs.",
    }),
    invoice_id: zId("invoice")
        .nullable()
        .openapi({
            description:
                "Die Rechnung, auf die verbucht wurde. `null` nur bei einer " +
                "Guthabenaufladung: dafür gibt es noch kein Dokument.",
            example: "invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD",
        }),
    customer_id: zId("customer").openapi({
        description: "Das Konto, dem der Vorgang gehört.",
    }),
    gateway: GATEWAY,
    status: STATUS,
    kind: KIND,
    purpose: z.enum(["invoice", "topup"]).openapi({
        description:
            "`invoice` zahlt auf ein Dokument, `topup` lädt Guthaben auf.",
        example: "invoice",
    }),
    parent_payment_id: zId("payment")
        .nullable()
        .openapi({
            description:
                "Bei einer Erstattung die Zahlung, die sie zurücknimmt. " +
                "Sonst `null`.",
            example: null,
        }),
    amount_cents: z.int().openapi({
        description:
            "Der Betrag in ganzen Cent, immer positiv — `kind` sagt, wohin " +
            "er zeigt.",
        example: 1999,
    }),
    refunded_cents: z.int().openapi({
        description:
            "Wie viel von dieser Zahlung bereits wieder hinausgegangen ist.",
        example: 0,
    }),
    currency: z.string().openapi({
        description: "ISO 4217.",
        example: "EUR",
    }),
    gateway_ref: z.string().openapi({
        description:
            "Die Referenz des Anbieters, unter der der Vorgang begonnen " +
            "wurde — eine Checkout-Session, eine PayPal-Order oder der " +
            "Idempotenzschlüssel einer Handbuchung. Eindeutig, und genau das " +
            "verhindert, dass derselbe Eingang zweimal verbucht wird.",
        example: "cs_test_a1b2c3",
    }),
    capture_ref: z
        .string()
        .nullable()
        .openapi({
            description:
                "Was das Geld tatsächlich bewegt hat — ein PaymentIntent " +
                "oder eine PayPal-Capture.",
            example: "pi_3QabcDEF",
        }),
    fee_cents: z.int().nullable().openapi({
        description: "Die Gebühr des Anbieters in ganzen Cent, sobald bekannt.",
        example: 62,
    }),
    failure_code: z.string().nullable().openapi({
        description: "Der Fehlercode des Anbieters, falls es schiefging.",
        example: null,
    }),
    failure_message: z.string().nullable().openapi({
        description: "Die Begründung des Anbieters im Klartext.",
        example: null,
    }),
    note: z
        .string()
        .nullable()
        .openapi({
            description:
                "Interne Notiz, etwa der Verwendungszweck einer Überweisung. " +
                "Wird dem Käufer nie angezeigt.",
            example: "RE-2026-0012",
        }),
    settled_at: z.iso
        .datetime()
        .nullable()
        .openapi({
            description:
                "Wann das Geld verbucht wurde, in UTC. `null`, solange der " +
                "Vorgang nicht erfolgreich ist.",
            example: "2026-11-07T09:12:00.000Z",
        }),
    created_at: z.iso.datetime().openapi({
        description: "Anlagezeitpunkt in UTC.",
        example: "2026-11-07T09:11:40.000Z",
    }),
});

export const TransactionSchema = registry.register(
    "Transaction",
    TransactionBase.openapi({
        description:
            "Eine Bewegung von Geld: eine Zahlung, eine Erstattung oder eine " +
            "Guthabenaufladung. Was eine Rechnung schuldet, sagt die " +
            "Rechnung; hier steht, was tatsächlich geflossen ist.",
    }),
);

export const TransactionPageSchema = cursorPage(
    TransactionSchema,
    "TransactionPage",
);

const NewPaymentSchema = registry.register(
    "NewPayment",
    z
        .object({
            amount_cents: z
                .int()
                .min(1)
                .max(99_999_999)
                .openapi({
                    description:
                        "Der eingegangene Betrag in ganzen Cent. Weniger als " +
                        "offen ist, lässt die Rechnung als `partial` stehen; " +
                        "mehr wird dem Konto als Guthaben gutgeschrieben, " +
                        "statt die Rechnung zu überzahlen.",
                    example: 1999,
                }),
            gateway: z
                .enum(["banktransfer", "stripe", "paypal"])
                .default("banktransfer")
                .openapi({
                    description:
                        "Auf welchem Weg das Geld kam. Voreinstellung ist " +
                        "`banktransfer` — der Fall, für den dieser Endpunkt " +
                        "da ist.",
                    example: "banktransfer",
                }),
            idempotency_key: z
                .string()
                .min(8)
                .max(200)
                .openapi({
                    description:
                        "Pflicht, und keine Höflichkeit: der Schlüssel wird " +
                        "die eindeutige Anbieterreferenz des Vorgangs. Eine " +
                        "nach einer verlorenen Antwort wiederholte Anfrage " +
                        "verbucht damit einmal statt zweimal und bekommt " +
                        "denselben Vorgang mit 200 zurück.",
                    example: "kontoauszug-2026-11-07-pos-14",
                }),
            reference: z
                .string()
                .max(200)
                .nullish()
                .openapi({
                    description:
                        "Verwendungszweck oder Beleg, intern. Mehrere " +
                        "Überweisungen dürfen denselben tragen — eindeutig " +
                        "ist `idempotency_key`.",
                    example: "RE-2026-0012",
                }),
            note: z.string().max(500).nullish().openapi({
                description: "Interne Notiz zum Vorgang.",
                example: "Teilzahlung nach Rücksprache",
            }),
            received_at: z.iso
                .datetime()
                .nullish()
                .openapi({
                    description:
                        "Wann das Geld ankam, in UTC. Fehlt es, gilt jetzt.",
                    example: "2026-11-07T00:00:00.000Z",
                }),
        })
        .openapi({
            description: "Ein Zahlungseingang, der von Hand verbucht wird.",
        }),
);

const RecordedPaymentSchema = registry.register(
    "RecordedPayment",
    TransactionBase.extend({
        invoice: z
            .object({
                status: z.string().openapi({
                    description:
                        "Der Status der Rechnung nach der Verbuchung — " +
                        "`partial`, wenn noch etwas offen ist.",
                    example: "paid",
                }),
                paid_cents: z.int().openapi({
                    description:
                        "Was insgesamt auf die Rechnung eingegangen ist.",
                    example: 1999,
                }),
                outstanding_cents: z.int().openapi({
                    description: "Was noch offen ist.",
                    example: 0,
                }),
                credited_to_balance_cents: z.int().openapi({
                    description:
                        "Was von dieser Zahlung über den offenen Betrag " +
                        "hinausging und dem Konto als Guthaben " +
                        "gutgeschrieben wurde.",
                    example: 0,
                }),
            })
            .openapi({
                description:
                    "Was die Verbuchung mit der Rechnung gemacht hat.",
            }),
    }).openapi({
        description: "Der angelegte Vorgang samt Wirkung auf die Rechnung.",
    }),
);

registry.registerPath({
    method: "get",
    path: "/api/v1/transactions",
    tags: ["Zahlungen"],
    summary: "Zahlungen auflisten",
    description:
        "Gibt die Zahlungsvorgänge seitenweise zurück, sortiert nach ID — " +
        "Zahlungen, Erstattungen und Guthabenaufladungen in einer Liste. Ein " +
        "Kundenschlüssel bekommt ausschließlich die Vorgänge des eigenen " +
        "Kontos; `customer_id` wird für ihn überschrieben statt beachtet. " +
        "Benötigt `payments.read`.",
    security: SECURITY,
    request: {
        query: CursorQuerySchema.extend({
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
            invoice_id: z
                .string()
                .optional()
                .openapi({
                    param: { name: "invoice_id", in: "query" },
                    description: "Auf eine Rechnung einschränken.",
                    example: "invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                }),
            provider: z
                .enum(["stripe", "paypal", "banktransfer", "credit"])
                .optional()
                .openapi({
                    param: { name: "provider", in: "query" },
                    description: "Auf einen Zahlungsweg einschränken.",
                    example: "stripe",
                }),
            status: z
                .enum([
                    "pending",
                    "processing",
                    "succeeded",
                    "failed",
                    "refunded",
                ])
                .optional()
                .openapi({
                    param: { name: "status", in: "query" },
                    description: "Auf einen Status einschränken.",
                    example: "succeeded",
                }),
            kind: z
                .enum(["charge", "refund"])
                .optional()
                .openapi({
                    param: { name: "kind", in: "query" },
                    description:
                        "Nur Zahlungen oder nur Erstattungen zeigen.",
                    example: "charge",
                }),
        }),
    },
    responses: {
        200: {
            description: "Eine Seite Zahlungsvorgänge.",
            content: {
                "application/json": { schema: TransactionPageSchema },
            },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/invoices/{id}/payments",
    tags: ["Zahlungen"],
    summary: "Zahlungseingang verbuchen",
    description:
        "Verbucht Geld, das außerhalb eines Zahlungsdienstleisters " +
        "angekommen ist — eine Überweisung auf dem Kontoauszug etwa — auf " +
        "eine ausgestellte Rechnung. Es läuft durch denselben Weg wie eine " +
        "Kartenzahlung, damit eine Rechnung nicht von zwei Mechanismen " +
        "unabhängig voneinander als bezahlt geführt werden kann.\n\n" +
        "Ein Teilbetrag lässt die Rechnung als `partial` offen; ein Betrag " +
        "über dem offenen Rest wird dem Konto als Guthaben gutgeschrieben, " +
        "statt die Rechnung zu überzahlen. `idempotency_key` wird zur " +
        "eindeutigen Referenz des Vorgangs: eine wiederholte Anfrage " +
        "verbucht nicht noch einmal, sondern gibt denselben Vorgang mit 200 " +
        "zurück.\n\n" +
        "Nur für Mitarbeiterschlüssel — ein Kundenschlüssel bekommt 404, " +
        "nicht 403. Benötigt `payments.write`.",
    security: SECURITY,
    request: {
        params: z.object({
            id: zId("invoice").openapi({
                param: { name: "id", in: "path" },
                description: "Die technische ID der Rechnung.",
            }),
        }),
        body: {
            required: true,
            content: {
                "application/json": { schema: NewPaymentSchema },
            },
        },
    },
    responses: {
        201: {
            description: "Der Vorgang wurde angelegt und verbucht.",
            content: {
                "application/json": { schema: RecordedPaymentSchema },
            },
        },
        200: {
            description:
                "Dieser `idempotency_key` war bereits verbucht; der " +
                "bestehende Vorgang wird unverändert zurückgegeben.",
            content: { "application/json": { schema: TransactionSchema } },
        },
        409: {
            description:
                "Die Rechnung ist nicht offen. Ein Eingang darauf wäre eine " +
                "Überzahlung und will von Hand entschieden werden.",
            content: {
                "application/problem+json": { schema: ProblemSchema },
            },
        },
        ...PROBLEM_RESPONSES,
    },
});
