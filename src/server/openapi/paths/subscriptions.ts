import { zId } from "@/lib/ulid";
import { apiKeyAuth, registry, z } from "../registry";
import {
    CursorQuerySchema,
    cursorPage,
    PROBLEM_RESPONSES,
    ProblemSchema,
} from "../schemas";

/**
 * `/api/v1/subscriptions` — the eight endpoints of Phase 6.
 *
 * Rule 11: an endpoint that is not described here is not done. Summary,
 * description, tag, schemas with per-field descriptions and examples, the
 * error shapes and the authentication each one needs.
 */

const SECURITY = [{ [apiKeyAuth.name]: [] }];

const STATUS = z
    .enum(["trialing", "active", "past_due", "paused", "cancelled", "ended"])
    .openapi({
        description:
            "`trialing` ist in der kostenlosen Testphase, `active` läuft, " +
            "`past_due` hat eine überfällige Rechnung (die Leistungen laufen " +
            "zunächst weiter — gesperrt wird erst im Mahnlauf), `paused` ist " +
            "angehalten und wird nicht berechnet, `cancelled` wird nicht mehr " +
            "verlängert und läuft bis zum Ende des bezahlten Zeitraums, " +
            "`ended` ist vorbei. Aus `ended` führt kein Weg zurück.",
        example: "active",
    });

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
        description: "Der Abrechnungsrhythmus des Abos.",
        example: "monthly",
    });

const SERVICE_STATUS = z
    .enum(["pending", "provisioning", "active", "suspended", "terminated"])
    .openapi({
        description:
            "`pending` ist bestellt und noch nicht eingerichtet, " +
            "`provisioning` wird gerade angelegt, `active` läuft, " +
            "`suspended` ist wegen einer offenen Rechnung gesperrt, " +
            "`terminated` ist abgebaut.",
        example: "active",
    });

const ServiceSchema = registry.register(
    "SubscriptionService",
    z
        .object({
            id: zId("service").openapi({
                description: "Technische ID der Leistung.",
            }),
            status: SERVICE_STATUS,
            label: z.string().openapi({
                description: "Wie die Leistung dem Kunden angezeigt wird.",
                example: "VPS M (1/2)",
            }),
            module: z.string().openapi({
                description:
                    "Das Bereitstellungsmodul, das sie betreut. `none`, " +
                    "solange nichts automatisch eingerichtet wird.",
                example: "none",
            }),
            activated_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie in Betrieb genommen wurde, in UTC.",
                example: "2026-11-01T09:00:00.000Z",
            }),
            suspended_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie gesperrt wurde, in UTC.",
                example: null,
            }),
            terminated_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie abgebaut wurde, in UTC.",
                example: null,
            }),
        })
        .openapi({
            description:
                "Eine bereitgestellte Sache — ein VPS, ein Webspace — die " +
                "zu einer Position des Abos gehört. Eine je bestellter " +
                "Einheit.",
        }),
);

const ItemSchema = registry.register(
    "SubscriptionItem",
    z
        .object({
            id: zId("subscriptionitem").openapi({
                description: "Technische ID der Position.",
            }),
            position: z.int().openapi({
                description: "Reihenfolge innerhalb des Abos, ab 1.",
                example: 1,
            }),
            product_id: zId("product").openapi({
                description: "Das Produkt, das berechnet wird.",
            }),
            description: z.string().openapi({
                description:
                    "Der Name des Produkts zum Zeitpunkt des Verkaufs. Der " +
                    "Katalog darf sich ändern; ein laufendes Abo wird davon " +
                    "nicht neu bepreist.",
                example: "VPS M",
            }),
            quantity: z.int().openapi({
                description: "Wie viele Einheiten berechnet werden.",
                example: 1,
            }),
            unit_price_cents: z.int().openapi({
                description:
                    "Grundpreis je Einheit und vollem Zeitraum, in ganzen " +
                    "Cent, wie verkauft.",
                example: 1999,
            }),
            recurring_gross_cents: z.int().openapi({
                description:
                    "Grundpreis plus Zusatzoptionen für einen vollen " +
                    "Zeitraum, vor einem Gutschein.",
                example: 2399,
            }),
            selections: z.array(z.unknown()).openapi({
                description:
                    "Die gewählten Zusatzoptionen mit den Namen und Preisen, " +
                    "zu denen sie verkauft wurden.",
                example: [],
            }),
            services: z.array(ServiceSchema).openapi({
                description:
                    "Die Leistungen, die zu dieser Position gehören. Leer " +
                    "bei einem reinen Abo-Produkt ohne Bereitstellung.",
            }),
        })
        .openapi({
            description: "Eine Position des Abos, zum verkauften Preis.",
        }),
);

const InvoiceRefSchema = registry.register(
    "SubscriptionInvoiceRef",
    z
        .object({
            id: zId("invoice").openapi({
                description: "Technische ID der Rechnung.",
            }),
            number: z.string().nullable().openapi({
                description: "Die lückenlose Rechnungsnummer.",
                example: "RE-2026-0042",
            }),
            status: z.string().openapi({
                description:
                    "`unpaid`, `partial`, `paid` oder `cancelled`. " +
                    "`partial` ist eine **offene** Rechnung.",
                example: "paid",
            }),
            kind: z
                .enum(["initial", "renewal", "change", "dunning_fee"])
                .openapi({
                    description:
                        "Wofür sie ausgestellt wurde: `initial` ist die " +
                        "Rechnung aus der Bestellung, `renewal` eine " +
                        "Verlängerung, `change` die anteilige Differenz " +
                        "eines sofortigen Tarifwechsels, `dunning_fee` eine " +
                        "Mahngebühr.",
                    example: "renewal",
                }),
            gross_cents: z.int().nullable().openapi({
                description: "Der Gesamtbetrag in ganzen Cent.",
                example: 1999,
            }),
            paid_cents: z.int().openapi({
                description: "Was darauf tatsächlich eingegangen ist.",
                example: 1999,
            }),
            due_at: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Wann sie fällig ist, in UTC. Von diesem Tag an werden " +
                        "Einzugsversuche und Mahnstufen gerechnet.",
                    example: "2026-12-01T00:00:00.000Z",
                }),
            issued_at: z.iso.datetime().nullable().openapi({
                description: "Das Rechnungsdatum, in UTC.",
                example: "2026-11-17T03:00:00.000Z",
            }),
            period_start: z.iso.datetime().openapi({
                description: "Beginn des Zeitraums, den sie bezahlt, in UTC.",
                example: "2026-12-01T00:00:00.000Z",
            }),
            period_end: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Ende dieses Zeitraums, exklusiv — der Augenblick, in " +
                        "dem der nächste beginnt.",
                    example: "2027-01-01T00:00:00.000Z",
                }),
        })
        .openapi({
            description:
                "Eine Rechnung, die gegen dieses Abo gestellt wurde, samt " +
                "dem Zeitraum, den sie bezahlt.",
        }),
);

const EventSchema = registry.register(
    "SubscriptionEvent",
    z
        .object({
            id: zId("subscriptionevent").openapi({
                description: "Technische ID des Eintrags.",
            }),
            kind: z.string().openapi({
                description:
                    "`status`, `period`, `change`, `dunning` oder `note`.",
                example: "status",
            }),
            from_status: z.string().nullable().openapi({
                description: "Der Status davor, bei einem Statuswechsel.",
                example: "past_due",
            }),
            to_status: z.string().nullable().openapi({
                description: "Der Status danach.",
                example: "active",
            }),
            summary: z.string().openapi({
                description: "Was passiert ist, in einem Satz. Deutsch.",
                example: "Zahlung eingegangen — wieder aktiv.",
            }),
            at: z.iso.datetime().nullable().openapi({
                description: "Wann es passiert ist, in UTC.",
                example: "2026-12-02T08:00:00.000Z",
            }),
        })
        .openapi({
            description:
                "Ein Eintrag in der Historie des Abos — dieselbe Zeitleiste, " +
                "die der Kunde im Portal sieht.",
        }),
);

const PendingChangeSchema = registry.register(
    "SubscriptionPendingChange",
    z
        .object({
            id: zId("subscriptionchange").openapi({
                description: "Technische ID des vorgemerkten Wechsels.",
            }),
            direction: z.string().openapi({
                description: "`upgrade`, `downgrade`, `quantity` oder `none`.",
                example: "upgrade",
            }),
            effective: z.enum(["immediately", "period_end"]).openapi({
                description: "Wann er greift.",
                example: "period_end",
            }),
            product_id: zId("product").openapi({
                description: "Das Produkt, auf das gewechselt wird.",
            }),
            description: z.string().openapi({
                description: "Der Name dieses Produkts.",
                example: "VPS L",
            }),
            quantity: z.int().openapi({
                description: "Die künftige Menge.",
                example: 1,
            }),
            recurring_gross_cents: z.int().openapi({
                description:
                    "Was ein voller Zeitraum danach kostet, vor Gutschein.",
                example: 3999,
            }),
            apply_at: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Wann er greift, in UTC — bei `period_end` der erste " +
                        "Augenblick des nächsten Zeitraums.",
                    example: "2027-01-01T00:00:00.000Z",
                }),
        })
        .openapi({
            description:
                "Ein Tarifwechsel, der vereinbart ist und zum Ende des " +
                "Zeitraums greift. Bis dahin zahlt der Kunde, was er hat.",
        }),
);

const SubscriptionBase = {
    id: zId("subscription").openapi({ description: "Technische ID des Abos." }),
    status: STATUS,
    cycle: CYCLE,
    currency: z.string().openapi({
        description: "ISO 4217. Jeder Betrag am Abo ist darin.",
        example: "EUR",
    }),
    current_period_start: z.iso.datetime().openapi({
        description: "Beginn des laufenden Zeitraums, in UTC.",
        example: "2026-11-01T08:00:00.000Z",
    }),
    current_period_end: z.iso
        .datetime()
        .nullable()
        .openapi({
            description:
                "Ende des laufenden Zeitraums, exklusiv — der Augenblick, in dem " +
                "der nächste beginnt. `null` bei einem einmaligen Verkauf.",
            example: "2026-12-01T00:00:00.000Z",
        }),
    next_billing_at: z.iso
        .datetime()
        .nullable()
        .openapi({
            description:
                "Wann die nächste Rechnung fällig wird. Die Rechnung selbst wird " +
                "einige Tage vorher gestellt. `null`, solange pausiert oder " +
                "beendet.",
            example: "2026-12-01T00:00:00.000Z",
        }),
    trial_ends_at: z.iso.datetime().nullable().openapi({
        description: "Ende der kostenlosen Testphase, in UTC.",
        example: null,
    }),
    cancel_at_period_end: z.boolean().openapi({
        description:
            "Ob das Abo zum Ende des bezahlten Zeitraums endet. Dann wird " +
            "keine Verlängerung mehr gestellt.",
        example: false,
    }),
    auto_charge: z.boolean().openapi({
        description:
            "Ob wir die Verlängerung vom hinterlegten Zahlungsmittel " +
            "einziehen. Ohne hinterlegtes Mittel passiert nichts.",
        example: true,
    }),
    customer_id: zId("customer").openapi({
        description: "Das Kundenkonto, dem das Abo gehört.",
    }),
    period_gross_cents: z.int().openapi({
        description:
            "Was ein voller Zeitraum aller Positionen kostet, vor einem " +
            "Gutschein, in ganzen Cent.",
        example: 1999,
    }),
};

export const SubscriptionListItemSchema = registry.register(
    "SubscriptionListItem",
    z
        .object({
            ...SubscriptionBase,
            label: z.string().openapi({
                description:
                    "Kurzbezeichnung für eine Liste — die erste Position, " +
                    "und wie viele weitere es gibt.",
                example: "VPS M",
            }),
        })
        .openapi({
            description: "Ein Abo, wie es in einer Liste erscheint.",
        }),
);

export const SubscriptionPageSchema = cursorPage(
    SubscriptionListItemSchema,
    "SubscriptionPage",
);

export const SubscriptionSchema = registry.register(
    "Subscription",
    z
        .object({
            ...SubscriptionBase,
            order_id: zId("order").nullable().openapi({
                description: "Die Bestellung, aus der es entstanden ist.",
                example: "order_01K9ZC4X7QG0VN3M8T6B2PFHRD",
            }),
            payment_method_id: zId("paymentmethod")
                .nullable()
                .openapi({
                    description:
                        "Das Zahlungsmittel, von dem eingezogen wird. `null` " +
                        "bedeutet: das Standardmittel des Kontos.",
                    example: null,
                }),
            coupon_code: z.string().nullable().openapi({
                description: "Der Gutscheincode, der mitläuft.",
                example: "WILLKOMMEN",
            }),
            discount_periods_remaining: z
                .int()
                .nullable()
                .openapi({
                    description:
                        "Wie viele **weitere** Zeiträume der Gutschein noch " +
                        "abdeckt. `null` heißt dauerhaft, `0` heißt " +
                        "aufgebraucht. Jede gestellte Verlängerung zählt einen " +
                        "herunter.",
                    example: 2,
                }),
            started_at: z.iso.datetime().nullable().openapi({
                description: "Wann das Abo begonnen hat, in UTC.",
                example: "2026-11-01T08:00:00.000Z",
            }),
            paused_at: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Seit wann es pausiert ist. Beim Fortsetzen wandert das " +
                        "Ende des Zeitraums um genau diese Spanne nach hinten.",
                    example: null,
                }),
            past_due_at: z.iso.datetime().nullable().openapi({
                description: "Seit wann eine Rechnung überfällig ist.",
                example: null,
            }),
            cancelled_at: z.iso.datetime().nullable().openapi({
                description: "Wann gekündigt wurde, in UTC.",
                example: null,
            }),
            ended_at: z.iso.datetime().nullable().openapi({
                description: "Wann es beendet wurde, in UTC.",
                example: null,
            }),
            items: z.array(ItemSchema).openapi({
                description: "Die Positionen, zu den verkauften Preisen.",
            }),
            invoices: z.array(InvoiceRefSchema).openapi({
                description:
                    "Jede Rechnung, die je gegen dieses Abo gestellt wurde, " +
                    "neueste zuerst.",
            }),
            events: z.array(EventSchema).openapi({
                description: "Die Historie, neueste zuerst, maximal 100.",
            }),
            pending_changes: z.array(PendingChangeSchema).openapi({
                description:
                    "Tarifwechsel, die zum Ende des Zeitraums greifen.",
            }),
        })
        .openapi({
            description:
                "Ein Abo: der Abrechnungsvertrag. Er sagt, was geschuldet " +
                "ist, für welchen Zeitraum und zu welchem Preis. Ein " +
                "Zahlungsdienstleister zieht nur Geld dagegen ein; die " +
                "Wahrheit über den Vertrag steht hier.",
        }),
);

const SubscriptionCreateSchema = registry.register(
    "SubscriptionCreate",
    z
        .object({
            customer_id: zId("customer")
                .nullish()
                .openapi({
                    description:
                        "Für welches Kundenkonto. Pflicht für einen " +
                        "Mitarbeiterschlüssel; bei einem Kundenschlüssel " +
                        "wird das Feld ignoriert.",
                }),
            items: z
                .array(
                    z.object({
                        product_id: z.string().openapi({
                            description: "ID oder Slug des Produkts.",
                            example: "vps-m",
                        }),
                        quantity: z.int().min(1).max(999).default(1).openapi({
                            description: "Wie viele Einheiten.",
                            example: 1,
                        }),
                        options: z
                            .array(
                                z.object({
                                    option_id: z.string().openapi({
                                        description: "ID der Zusatzoption.",
                                        example:
                                            "configoption_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                                    }),
                                    value_id: z.string().openapi({
                                        description: "ID des gewählten Werts.",
                                        example:
                                            "configoptionvalue_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                                    }),
                                    quantity: z
                                        .int()
                                        .min(0)
                                        .max(9999)
                                        .default(1)
                                        .openapi({
                                            description:
                                                "Einheiten dieses Werts.",
                                            example: 1,
                                        }),
                                }),
                            )
                            .default([])
                            .openapi({
                                description: "Die gewählten Zusatzoptionen.",
                            }),
                    }),
                )
                .min(1)
                .max(50)
                .openapi({
                    description:
                        "Die Positionen des Abos. Alle teilen sich den " +
                        "Rhythmus und die Währung unten.",
                }),
            cycle: CYCLE,
            currency: z.string().default("EUR").openapi({
                description: "ISO 4217.",
                example: "EUR",
            }),
            coupon_code: z.string().nullish().openapi({
                description: "Ein Gutscheincode, der mitlaufen soll.",
                example: "WILLKOMMEN",
            }),
            auto_charge: z
                .boolean()
                .default(false)
                .openapi({
                    description:
                        "Verlängerungen automatisch einziehen, sobald ein " +
                        "Zahlungsmittel hinterlegt ist.",
                    example: true,
                }),
            accept_terms: z.boolean().default(false).openapi({
                description:
                    "Bestätigung der AGB. Ohne sie wird nichts angelegt.",
                example: true,
            }),
            accept_withdrawal: z
                .boolean()
                .default(false)
                .openapi({
                    description:
                        "Kenntnisnahme der Widerrufsbelehrung. Nur für " +
                        "Verbraucher erforderlich.",
                    example: true,
                }),
            request_immediate_start: z
                .boolean()
                .default(false)
                .openapi({
                    description:
                        "Ausdrückliches Verlangen nach sofortigem Beginn der " +
                        "Leistung, § 356 Abs. 4 BGB. Nur für Verbraucher.",
                    example: true,
                }),
            note: z.string().nullish().openapi({
                description: "Interne Notiz zur Bestellung.",
                example: null,
            }),
        })
        .openapi({
            description:
                "Ein neues Abo. Es entsteht über denselben Bestellvorgang " +
                "wie im Shop — eine Bestellung, eine Rechnung, die " +
                "Leistungen — damit es genau einen Weg gibt, auf dem ein Abo " +
                "zur Welt kommt.",
        }),
);

const CancelSchema = registry.register(
    "SubscriptionCancel",
    z
        .object({
            when: z
                .enum(["now", "period_end"])
                .default("period_end")
                .openapi({
                    description:
                        "`period_end` lässt den bezahlten Zeitraum auslaufen — " +
                        "die Leistungen laufen weiter und es wird keine " +
                        "Verlängerung mehr gestellt. `now` beendet sofort und " +
                        "baut die Leistungen ab.",
                    example: "period_end",
                }),
            reason: z.string().nullish().openapi({
                description: "Warum gekündigt wird. Wird am Abo vermerkt.",
                example: "Projekt eingestellt",
            }),
        })
        .openapi({
            description:
                "Eine Kündigung. Sie erstattet nichts — ob etwas " +
                "zurückgezahlt wird, entscheidet der Betreiber (§ 8 AGB).",
        }),
);

const PauseSchema = registry.register(
    "SubscriptionPause",
    z
        .object({
            reason: z.string().nullish().openapi({
                description: "Warum pausiert wird.",
                example: "Umzug des Projekts",
            }),
        })
        .openapi({
            description:
                "Hält das Abo an: keine Rechnungen, Leistungen gesperrt.",
        }),
);

const ResumeSchema = registry.register(
    "SubscriptionResume",
    z
        .object({
            what: z
                .enum(["auto", "paused", "cancellation"])
                .default("auto")
                .openapi({
                    description:
                        "`paused` nimmt ein pausiertes Abo wieder in " +
                        "Betrieb, `cancellation` nimmt eine Kündigung zum " +
                        "Ende des Zeitraums zurück. `auto` wählt das, was " +
                        "zutrifft — beides zugleich kann ein Abo nicht sein.",
                    example: "auto",
                }),
        })
        .openapi({
            description: "Setzt ein Abo fort.",
        }),
);

const ChangeSchema = registry.register(
    "SubscriptionChange",
    z
        .object({
            item_id: zId("subscriptionitem").openapi({
                description: "Welche Position gewechselt wird.",
            }),
            product_id: z.string().nullish().openapi({
                description:
                    "Das neue Produkt. Fehlt es, bleibt das bisherige.",
                example: "vps-l",
            }),
            quantity: z.int().min(1).max(999).nullish().openapi({
                description: "Die neue Menge. Fehlt sie, bleibt die bisherige.",
                example: 2,
            }),
            options: z
                .array(
                    z.object({
                        option_id: z.string().openapi({
                            description: "ID der Zusatzoption.",
                            example: "configoption_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                        }),
                        value_id: z.string().openapi({
                            description: "ID des gewählten Werts.",
                            example:
                                "configoptionvalue_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                        }),
                        quantity: z.int().min(0).max(9999).default(1).openapi({
                            description: "Einheiten dieses Werts.",
                            example: 2,
                        }),
                    }),
                )
                .nullish()
                .openapi({
                    description:
                        "Die neuen Zusatzoptionen. Fehlt das Feld, bleiben " +
                        "die bisherigen; eine leere Liste entfernt alle.",
                }),
            effective: z
                .enum(["immediately", "period_end"])
                .default("immediately")
                .openapi({
                    description:
                        "`immediately` wechselt sofort und rechnet die " +
                        "Differenz für die Resttage ab — bei einem Upgrade " +
                        "als Rechnung, bei einem Downgrade als Guthaben. " +
                        "`period_end` merkt den Wechsel vor; heute fließt " +
                        "nichts.",
                    example: "immediately",
                }),
        })
        .openapi({
            description:
                "Ein Tarifwechsel. Dieselben Felder wie bei der Vorschau, " +
                "und dieselbe Rechnung dahinter.",
        }),
);

const ProrationSchema = registry.register(
    "SubscriptionProration",
    z
        .object({
            remaining_days: z.int().openapi({
                description:
                    "Tage des laufenden Zeitraums, die noch kommen — der " +
                    "heutige eingeschlossen.",
                example: 15,
            }),
            period_days: z.int().openapi({
                description: "Tage, die ein voller Zeitraum umfasst.",
                example: 30,
            }),
            unused_credit_cents: z.int().openapi({
                description:
                    "Der nicht verbrauchte Teil dessen, was schon bezahlt " +
                    "ist, in ganzen Cent.",
                example: 1000,
            }),
            new_charge_cents: z.int().openapi({
                description: "Dieselben Tage zum neuen Preis, in ganzen Cent.",
                example: 2000,
            }),
            difference_cents: z.int().openapi({
                description:
                    "Was den Besitzer wechselt. Positiv schuldet der Kunde " +
                    "und wird in Rechnung gestellt; negativ schulden wir und " +
                    "es wird dem Guthaben gutgeschrieben. Eine Richtung, " +
                    "eine Zahl.",
                example: 1000,
            }),
        })
        .openapi({
            description:
                "Die anteilige Abrechnung für den Rest des laufenden " +
                "Zeitraums: zurückgeben, was nicht verbraucht ist, und " +
                "dieselben Tage zum neuen Preis berechnen.",
        }),
);

const PlanSideSchema = z
    .object({
        product_id: z.string().openapi({
            description: "Das Produkt.",
            example: "product_01K9ZC4X7QG0VN3M8T6B2PFHRD",
        }),
        description: z.string().openapi({
            description: "Sein Name.",
            example: "VPS L",
        }),
        quantity: z.int().openapi({
            description: "Die Menge.",
            example: 1,
        }),
        unit_price_cents: z.int().openapi({
            description: "Grundpreis je Einheit und vollem Zeitraum.",
            example: 3999,
        }),
        recurring_gross_cents: z.int().openapi({
            description: "Grundpreis plus Optionen für einen vollen Zeitraum.",
            example: 3999,
        }),
    })
    .openapi({ description: "Eine Seite des Wechsels." });

export const ChangePreviewSchema = registry.register(
    "SubscriptionChangePreview",
    z
        .object({
            subscription_id: zId("subscription").openapi({
                description: "Das Abo.",
            }),
            item_id: zId("subscriptionitem").openapi({
                description: "Die Position, um die es geht.",
            }),
            currency: z.string().openapi({
                description: "ISO 4217.",
                example: "EUR",
            }),
            cycle: CYCLE,
            effective: z.enum(["immediately", "period_end"]).openapi({
                description: "Wann der Wechsel greifen würde.",
                example: "immediately",
            }),
            apply_at: z.iso.datetime().nullable().openapi({
                description: "Der Augenblick, ab dem er gilt, in UTC.",
                example: "2026-11-16T08:00:00.000Z",
            }),
            direction: z.string().openapi({
                description: "`upgrade`, `downgrade` oder `none`.",
                example: "upgrade",
            }),
            current: PlanSideSchema.openapi({
                description: "Was heute gilt.",
            }),
            next: PlanSideSchema.openapi({
                description: "Was danach gilt.",
            }),
            proration: ProrationSchema.openapi({
                description:
                    "Die anteilige Abrechnung für den Rest des laufenden " +
                    "Zeitraums.",
            }),
            invoice_today_cents: z.int().openapi({
                description:
                    "Was heute in Rechnung gestellt wird, in ganzen Cent. " +
                    "0 bei einem Downgrade oder bei einem Wechsel zum Ende " +
                    "des Zeitraums.",
                example: 1000,
            }),
            credit_today_cents: z.int().openapi({
                description:
                    "Was heute dem Guthaben gutgeschrieben wird. Die " +
                    "Spiegelung von `invoice_today_cents`; eins von beiden " +
                    "ist immer 0.",
                example: 0,
            }),
            current_period_cents: z.int().openapi({
                description:
                    "Was ein voller Zeitraum des ganzen Abos heute kostet.",
                example: 1999,
            }),
            next_period_cents: z.int().openapi({
                description: "Was er danach kostet.",
                example: 3999,
            }),
            label: z.string().openapi({
                description:
                    "Die Zeile, die auf der Rechnung stehen würde. Deutsch.",
                example: "Tarifwechsel: VPS L — anteilig für 15 von 30 Tagen",
            }),
        })
        .openapi({
            description:
                "Was ein Tarifwechsel kosten würde, auf den Cent. Genau die " +
                "Zahl, die `POST …/change` anschließend bucht — beide " +
                "stammen aus derselben Funktion.",
        }),
);

const ChangeResultSchema = registry.register(
    "SubscriptionChangeResult",
    z
        .object({
            subscription: SubscriptionSchema.openapi({
                description: "Das Abo, wie es nach dem Wechsel aussieht.",
            }),
            preview: ChangePreviewSchema.openapi({
                description:
                    "Die Abrechnung, die gebucht wurde — dieselbe, die " +
                    "`GET …/preview-change` vorher gezeigt hätte.",
            }),
            change_id: zId("subscriptionchange").openapi({
                description: "Der festgehaltene Wechsel.",
            }),
            invoice_id: zId("invoice")
                .nullable()
                .openapi({
                    description:
                        "Die Rechnung über die anteilige Differenz, falls eine " +
                        "gestellt wurde.",
                    example: "invoice_01K9ZC4X7QG0VN3M8T6B2PFHRD",
                }),
            invoice_number: z.string().nullable().openapi({
                description: "Ihre Nummer.",
                example: "RE-2026-0043",
            }),
            credited_cents: z.int().openapi({
                description:
                    "Was stattdessen dem Guthaben gutgeschrieben wurde.",
                example: 0,
            }),
            applied_now: z.boolean().openapi({
                description:
                    "Ob der Wechsel sofort gilt oder erst zum Ende des " +
                    "Zeitraums.",
                example: true,
            }),
        })
        .openapi({
            description: "Das Ergebnis eines Tarifwechsels.",
        }),
);

const PreviewResponseSchema = registry.register(
    "SubscriptionChangePreviewResponse",
    ChangePreviewSchema.extend({
        summary: z.string().openapi({
            description:
                "Ein Satz, der die Zahlen zusammenfasst — fertig zum " +
                "Anzeigen. Deutsch.",
            example: "Heute 10,00 € anteilig, danach 39,99 € je Zeitraum.",
        }),
    }).openapi({
        description: "Die Vorschau samt fertigem Satz dazu.",
    }),
);

const ID_PARAM = z.object({
    id: zId("subscription").openapi({
        param: { name: "id", in: "path" },
        description: "Die technische ID des Abos.",
    }),
});

const CONFLICT = {
    409: {
        description:
            "Der Zustand des Abos lässt das nicht zu — ein beendetes Abo " +
            "lässt sich nicht kündigen, ein laufendes nicht fortsetzen. Der " +
            "Grund steht im `detail`.",
        content: { "application/problem+json": { schema: ProblemSchema } },
    },
};

registry.registerPath({
    method: "get",
    path: "/api/v1/subscriptions",
    tags: ["Abos"],
    summary: "Abos auflisten",
    description:
        "Gibt die Abos seitenweise zurück, sortiert nach ID. Ein " +
        "Kundenschlüssel bekommt ausschließlich die eigenen; `customer_id` " +
        "wird für ihn überschrieben statt beachtet. Benötigt " +
        "`subscriptions.read`.",
    security: SECURITY,
    request: {
        query: CursorQuerySchema.extend({
            status: z
                .enum([
                    "trialing",
                    "active",
                    "past_due",
                    "paused",
                    "cancelled",
                    "ended",
                ])
                .optional()
                .openapi({
                    param: { name: "status", in: "query" },
                    description: "Auf einen Status einschränken.",
                    example: "active",
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
            description: "Eine Seite Abos.",
            content: { "application/json": { schema: SubscriptionPageSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/subscriptions",
    tags: ["Abos"],
    summary: "Abo anlegen",
    description:
        "Legt ein Abo an — über denselben Bestellvorgang wie der Shop, " +
        "damit es genau einen Weg gibt, auf dem ein Abo zur Welt kommt: " +
        "Bestellung, Positionen, Leistungen und die erste ausgestellte " +
        "Rechnung in einer Transaktion. Zurückgegeben wird das entstandene " +
        "Abo; wer die Bestellung selbst braucht, nimmt " +
        "`POST /api/v1/orders`.\n\n" +
        "Die Preise werden hier neu aus dem Katalog gerechnet. Nichts, was " +
        "der Aufrufer sendet, ist ein Preis.\n\n" +
        "Benötigt `subscriptions.write`.",
    security: SECURITY,
    request: {
        body: {
            required: true,
            content: {
                "application/json": { schema: SubscriptionCreateSchema },
            },
        },
    },
    responses: {
        201: {
            description: "Das Abo wurde angelegt.",
            content: { "application/json": { schema: SubscriptionSchema } },
        },
        ...PROBLEM_RESPONSES,
        422: {
            description:
                "Die Eingabe ist so nicht bestellbar — ein Produkt gibt es " +
                "nicht, die AGB wurden nicht bestätigt, oder die Position " +
                "begründet gar kein Abo.",
            content: {
                "application/problem+json": { schema: ProblemSchema },
            },
        },
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/subscriptions/{id}",
    tags: ["Abos"],
    summary: "Abo ansehen",
    description:
        "Ein Abo mit seinen Positionen, den Leistungen darunter, jeder je " +
        "dagegen gestellten Rechnung und seiner Historie. Ein Schlüssel, der " +
        "die Zeile nicht sehen darf, bekommt 404 statt 403 — 403 würde " +
        "bestätigen, dass die ID existiert. Benötigt `subscriptions.read`.",
    security: SECURITY,
    request: { params: ID_PARAM },
    responses: {
        200: {
            description: "Das Abo.",
            content: { "application/json": { schema: SubscriptionSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/subscriptions/{id}/cancel",
    tags: ["Abos"],
    summary: "Abo kündigen",
    description:
        "Kündigt zum Ende des bezahlten Zeitraums (Voreinstellung) oder " +
        "sofort. Bei `period_end` laufen die Leistungen weiter, es wird " +
        "keine Verlängerung mehr gestellt, und der tägliche Lauf beendet das " +
        "Abo an dem Tag. Bei `now` endet es heute und die Leistungen werden " +
        "abgebaut.\n\n" +
        "Es wird nichts erstattet: ob Geld zurückgeht, entscheidet der " +
        "Betreiber (§ 8 AGB). Benötigt `subscriptions.write`.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        body: {
            required: false,
            content: { "application/json": { schema: CancelSchema } },
        },
    },
    responses: {
        200: {
            description: "Das Abo nach der Kündigung.",
            content: { "application/json": { schema: SubscriptionSchema } },
        },
        ...CONFLICT,
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/subscriptions/{id}/pause",
    tags: ["Abos"],
    summary: "Abo pausieren",
    description:
        "Hält das Abo an: es wird nichts mehr berechnet und die Leistungen " +
        "werden gesperrt. Beim Fortsetzen wandert das Ende des Zeitraums um " +
        "genau die Spanne nach hinten, die es stillstand — der Kunde " +
        "verliert die Tage nicht, die er nicht nutzen konnte, und gewinnt " +
        "auch keine. Benötigt `subscriptions.write`.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        body: {
            required: false,
            content: { "application/json": { schema: PauseSchema } },
        },
    },
    responses: {
        200: {
            description: "Das pausierte Abo.",
            content: { "application/json": { schema: SubscriptionSchema } },
        },
        ...CONFLICT,
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/subscriptions/{id}/resume",
    tags: ["Abos"],
    summary: "Abo fortsetzen",
    description:
        "Setzt ein pausiertes Abo fort oder nimmt eine Kündigung zum Ende " +
        "des Zeitraums zurück. `what` sagt, welches von beidem; `auto` " +
        "wählt das, was zutrifft. Benötigt `subscriptions.write`.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        body: {
            required: false,
            content: { "application/json": { schema: ResumeSchema } },
        },
    },
    responses: {
        200: {
            description: "Das fortgesetzte Abo.",
            content: { "application/json": { schema: SubscriptionSchema } },
        },
        ...CONFLICT,
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/subscriptions/{id}/change",
    tags: ["Abos"],
    summary: "Tarif wechseln",
    description:
        "Wechselt eine Position auf ein anderes Produkt, eine andere Menge " +
        "oder andere Optionen.\n\n" +
        "Bei `immediately` wird die Differenz für die Resttage des " +
        "laufenden Zeitraums abgerechnet: ein Upgrade als Rechnung, ein " +
        "Downgrade als Guthaben auf dem Konto — dieselbe Zahl, nur mit " +
        "umgekehrtem Vorzeichen. Bei `period_end` fließt heute nichts und " +
        "die nächste Verlängerung wird aus der neuen Konfiguration gebaut.\n\n" +
        "Die Beträge stammen aus derselben Funktion wie " +
        "`GET …/preview-change`; die Vorschau und die Buchung können nicht " +
        "auseinanderlaufen. Benötigt `subscriptions.write`.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        body: {
            required: true,
            content: { "application/json": { schema: ChangeSchema } },
        },
    },
    responses: {
        200: {
            description:
                "Der Wechsel ist gebucht; das Abo und die Abrechnung dazu.",
            content: { "application/json": { schema: ChangeResultSchema } },
        },
        ...CONFLICT,
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/subscriptions/{id}/preview-change",
    tags: ["Abos"],
    summary: "Tarifwechsel vorab rechnen",
    description:
        "Was ein Tarifwechsel kosten würde, auf den Cent, ohne etwas zu " +
        "ändern. Genau die Zahl, die `POST …/change` anschließend bucht.\n\n" +
        "Die Felder entsprechen denen des Wechsels; Optionen werden als " +
        "wiederholter Parameter `option=optionId:valueId:menge` übergeben, " +
        "weil ein GET keinen Körper hat. Fehlt `option` ganz, bleiben die " +
        "bisherigen Optionen stehen.\n\n" +
        "Benötigt `subscriptions.read` — eine Vorschau ändert nichts.",
    security: SECURITY,
    request: {
        params: ID_PARAM,
        query: z.object({
            item_id: z.string().openapi({
                param: { name: "item_id", in: "query" },
                description: "Welche Position gewechselt würde.",
                example: "subscriptionitem_01K9ZC4X7QG0VN3M8T6B2PFHRD",
            }),
            product_id: z
                .string()
                .optional()
                .openapi({
                    param: { name: "product_id", in: "query" },
                    description:
                        "Das neue Produkt. Fehlt es, bleibt das bisherige.",
                    example: "vps-l",
                }),
            quantity: z.coerce
                .number()
                .int()
                .optional()
                .openapi({
                    param: { name: "quantity", in: "query" },
                    description: "Die neue Menge.",
                    example: 2,
                }),
            option: z
                .array(z.string())
                .optional()
                .openapi({
                    param: { name: "option", in: "query" },
                    description:
                        "Eine Zusatzoption als `optionId:valueId:menge`. " +
                        "Mehrfach angebbar.",
                    example: ["configoption_01ABC:configoptionvalue_01DEF:2"],
                }),
            effective: z
                .enum(["immediately", "period_end"])
                .optional()
                .openapi({
                    param: { name: "effective", in: "query" },
                    description: "Wann der Wechsel greifen würde.",
                    example: "immediately",
                }),
        }),
    },
    responses: {
        200: {
            description: "Die Vorschau.",
            content: { "application/json": { schema: PreviewResponseSchema } },
        },
        ...CONFLICT,
        ...PROBLEM_RESPONSES,
    },
});
