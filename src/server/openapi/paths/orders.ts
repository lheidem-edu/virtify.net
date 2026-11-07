import { zId } from "@/lib/ulid";
import { apiKeyAuth, registry, z } from "../registry";
import { PROBLEM_RESPONSES } from "../schemas";

/**
 * `/api/v1/orders`. Rule 11: an endpoint that is not described here is not
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

const ORDER_STATUS = z
    .enum(["pending", "active", "cancelled", "fraud"])
    .openapi({
        description:
            "`pending` ist aufgegeben und noch nicht angenommen — es wird " +
            "nichts bereitgestellt. `active` ist angenommen, `cancelled` " +
            "storniert, `fraud` als Betrug abgelehnt.",
        example: "pending",
    });

const PAYMENT_OPTION = z.enum(["bank_transfer"]).openapi({
    description:
        "Wie bezahlt werden soll. Zurzeit nur `bank_transfer`; Stripe und " +
        "PayPal folgen in Phase 5.",
    example: "bank_transfer",
});

export const OrderCreateSchema = registry.register(
    "OrderCreate",
    z
        .object({
            customer_id: zId("customer")
                .nullish()
                .openapi({
                    description:
                        "Für welches Kundenkonto bestellt wird. Pflicht für " +
                        "einen Mitarbeiterschlüssel; bei einem Kundenschlüssel " +
                        "wird das Feld ignoriert und für dessen eigenes Konto " +
                        "bestellt.",
                }),
            items: z
                .array(
                    z.object({
                        product_id: z.string().openapi({
                            description:
                                "Das Produkt — technische ID oder Kürzel.",
                            example: "vps-m",
                        }),
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
                                        description:
                                            "Welche Option gewählt wurde.",
                                    }),
                                    value_id: zId("configoptionvalue").openapi({
                                        description:
                                            "Welcher Wert dieser Option.",
                                    }),
                                    quantity: z
                                        .int()
                                        .min(0)
                                        .max(9999)
                                        .default(1)
                                        .openapi({
                                            description:
                                                "Einheiten bei `quantity`-Optionen; " +
                                                "bei `select` immer 1.",
                                            example: 1,
                                        }),
                                }),
                            )
                            .default([])
                            .openapi({
                                description:
                                    "Die gewählten Zusatzleistungen. Eine Option, " +
                                    "die es nicht gibt, lässt die Bestellung " +
                                    "scheitern statt übergangen zu werden.",
                            }),
                        coupon_code: z
                            .string()
                            .nullish()
                            .openapi({
                                description:
                                    "Ein Gutscheincode für diese Position. Er wird " +
                                    "bei der Bestellung eingelöst und zählt einmal " +
                                    "je Bestellung, nicht je Position.",
                                example: "WILLKOMMEN",
                            }),
                    }),
                )
                .min(1)
                .max(50)
                .openapi({
                    description: "Was bestellt wird, Position für Position.",
                }),
            payment_option: PAYMENT_OPTION,
            auto_charge: z
                .boolean()
                .default(false)
                .openapi({
                    description:
                        "Ob wiederkehrende Beträge später automatisch eingezogen " +
                        "werden dürfen. Phase 5 wertet das aus.",
                    example: false,
                }),
            accept_terms: z
                .boolean()
                .default(false)
                .openapi({
                    description:
                        "Bestätigung der AGB. Ohne sie wird die Bestellung mit " +
                        "422 abgelehnt; die geltende Fassung wird mit Zeitstempel " +
                        "an der Bestellung gespeichert.",
                    example: true,
                }),
            accept_withdrawal: z
                .boolean()
                .default(false)
                .openapi({
                    description:
                        "Bestätigung der Widerrufsbelehrung. Pflicht, wenn das " +
                        "Konto eine Privatperson ist; bei einer Firma ohne " +
                        "Bedeutung, denn ihr steht kein Widerrufsrecht zu.",
                    example: true,
                }),
            request_immediate_start: z
                .boolean()
                .default(false)
                .openapi({
                    description:
                        "Das ausdrückliche Verlangen nach § 356 Abs. 4 BGB, vor " +
                        "Ablauf der Widerrufsfrist mit der Leistung zu beginnen. " +
                        "Pflicht für eine Privatperson.",
                    example: true,
                }),
            note: z.string().nullish().openapi({
                description: "Eine interne Notiz zur Bestellung.",
                example: null,
            }),
        })
        .openapi({
            description:
                "Eine Bestellung. Jeder Preis wird beim Anlegen neu aus dem " +
                "Katalog berechnet — übermittelte Beträge gibt es nicht und " +
                "würden auch nicht geglaubt.",
        }),
);

const OrderItemSchema = registry.register(
    "OrderItem",
    z
        .object({
            id: zId("orderitem").openapi({
                description: "Technische ID der Position.",
            }),
            position: z.int().openapi({
                description: "Laufende Nummer innerhalb der Bestellung.",
                example: 1,
            }),
            product_id: zId("product").openapi({
                description: "Das bestellte Produkt.",
            }),
            description: z.string().openapi({
                description: "Der Produktname zum Zeitpunkt der Bestellung.",
                example: "VPS M",
            }),
            cycle: CYCLE,
            currency: z.string().openapi({
                description: "Währung aller Beträge dieser Position.",
                example: "EUR",
            }),
            quantity: z.int().openapi({
                description: "Bestellte Einheiten.",
                example: 1,
            }),
            unit_price_cents: z.int().openapi({
                description: "Grundpreis je Einheit und Zeitraum, in Cent.",
                example: 1999,
            }),
            setup_fee_cents: z.int().openapi({
                description: "Einmalige Einrichtungsgebühr, in Cent.",
                example: 1000,
            }),
            trial_days: z.int().openapi({
                description: "Freie Tage vor der ersten laufenden Abrechnung.",
                example: 0,
            }),
            recurring_gross_cents: z.int().openapi({
                description:
                    "Grundpreis und Optionen für einen Zeitraum, vor Gutschein.",
                example: 2499,
            }),
            recurring_discount_cents: z.int().openapi({
                description: "Was der Gutschein von einem Zeitraum abzieht.",
                example: 625,
            }),
            first_period_cents: z.int().openapi({
                description:
                    "Was ein Zeitraum kostet, solange der Gutschein gilt.",
                example: 1874,
            }),
            renewal_cents: z.int().openapi({
                description:
                    "Was ein Zeitraum kostet, sobald er nicht mehr gilt.",
                example: 2499,
            }),
            setup_cents: z.int().openapi({
                description: "Einrichtungsgebühren nach Gutschein, in Cent.",
                example: 1000,
            }),
            due_today_cents: z.int().openapi({
                description:
                    "Was diese Position auf die erste Rechnung gebracht hat — " +
                    "nach einer etwaigen anteiligen Berechnung. Die Summe über " +
                    "alle Positionen ist der Nettobetrag der Rechnung.",
                example: 2874,
            }),
            coupon_code: z.string().nullable().openapi({
                description: "Der eingelöste Gutscheincode, sonst `null`.",
                example: "WILLKOMMEN",
            }),
            discount_periods: z
                .int()
                .nullable()
                .openapi({
                    description:
                        "Für wie viele Zeiträume der Gutschein gilt. `null` " +
                        "heißt dauerhaft, `0` heißt: keiner angewandt.",
                    example: 1,
                }),
        })
        .openapi({ description: "Eine Position der Bestellung." }),
);

const SubscriptionItemSchema = registry.register(
    "SubscriptionItem",
    z
        .object({
            id: zId("subscriptionitem").openapi({
                description: "Technische ID der Abo-Position.",
            }),
            product_id: zId("product").openapi({
                description: "Das Produkt, das abgerechnet wird.",
            }),
            description: z.string().openapi({
                description: "Der Produktname zum Zeitpunkt des Verkaufs.",
                example: "VPS M",
            }),
            quantity: z.int().openapi({
                description: "Abgerechnete Einheiten.",
                example: 1,
            }),
            unit_price_cents: z.int().openapi({
                description:
                    "Grundpreis je Einheit und Zeitraum, wie verkauft, in Cent.",
                example: 1999,
            }),
            recurring_gross_cents: z.int().openapi({
                description:
                    "Was diese Position je Zeitraum kostet, vor Gutschein — " +
                    "die Grundlage jeder Verlängerungsrechnung.",
                example: 2499,
            }),
        })
        .openapi({
            description: "Eine Position eines Abonnements, mit Preisstand.",
        }),
);

const SubscriptionSchema = registry.register(
    "Subscription",
    z
        .object({
            id: zId("subscription").openapi({
                description: "Technische ID des Abonnements.",
            }),
            status: z
                .enum([
                    "trialing",
                    "active",
                    "past_due",
                    "paused",
                    "cancelled",
                    "ended",
                ])
                .openapi({
                    description:
                        "`trialing` innerhalb der Testphase, `active` laufend, " +
                        "`past_due` mit offener Rechnung, `cancelled` gekündigt, " +
                        "`ended` beendet.",
                    example: "active",
                }),
            cycle: CYCLE,
            currency: z.string().openapi({
                description: "Währung des Abonnements nach ISO 4217.",
                example: "EUR",
            }),
            current_period_start: z.iso.datetime().openapi({
                description: "Beginn des bezahlten Zeitraums, in UTC.",
                example: "2026-11-07T10:00:00.000Z",
            }),
            current_period_end: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Ende des bezahlten Zeitraums, in UTC — zugleich der " +
                        "Beginn des nächsten. `null` bei einem einmaligen Verkauf.",
                    example: "2026-12-07T10:00:00.000Z",
                }),
            next_billing_at: z.iso.datetime().nullable().openapi({
                description:
                    "Wann die nächste Rechnung fällig wird; `null`, wenn keine folgt.",
                example: "2026-12-07T10:00:00.000Z",
            }),
            trial_ends_at: z.iso.datetime().nullable().openapi({
                description: "Ende der Testphase, falls es eine gibt.",
                example: null,
            }),
            auto_charge: z.boolean().openapi({
                description:
                    "Ob die Verlängerung automatisch eingezogen werden darf.",
                example: false,
            }),
            items: z.array(SubscriptionItemSchema).openapi({
                description: "Was das Abonnement abrechnet.",
            }),
        })
        .openapi({
            description:
                "Ein Abonnement — die Abrechnungsvereinbarung selbst, nicht die " +
                "eines Zahlungsdienstleisters.",
        }),
);

const ServiceSchema = registry.register(
    "Service",
    z
        .object({
            id: zId("service").openapi({
                description: "Technische ID der Leistung.",
            }),
            status: z
                .enum([
                    "pending",
                    "provisioning",
                    "active",
                    "suspended",
                    "terminated",
                ])
                .openapi({
                    description:
                        "`pending` bestellt und noch nicht eingerichtet, " +
                        "`provisioning` in Einrichtung, `active` nutzbar, " +
                        "`suspended` gesperrt, `terminated` beendet.",
                    example: "pending",
                }),
            label: z.string().openapi({
                description: "Wie die Leistung dem Kunden gegenüber heißt.",
                example: "VPS M",
            }),
            product_id: zId("product").openapi({
                description: "Das Produkt, aus dem sie entstanden ist.",
            }),
            subscription_item_id: z.string().nullable().openapi({
                description: "Die Abo-Position, die sie bezahlt.",
                example: null,
            }),
        })
        .openapi({
            description:
                "Eine bereitzustellende Leistung. In Phase 4 entsteht sie " +
                "`pending`; eingerichtet wird sie ab Phase 8.",
        }),
);

export const OrderSchema = registry.register(
    "Order",
    z
        .object({
            id: zId("order").openapi({
                description: "Technische ID der Bestellung.",
            }),
            number: z.string().openapi({
                description: "Die Bestellnummer.",
                example: "BS-2026-0001",
            }),
            status: ORDER_STATUS,
            customer_id: zId("customer").openapi({
                description: "Das Kundenkonto, dem sie gehört.",
            }),
            currency: z.string().openapi({
                description: "Währung aller Beträge nach ISO 4217.",
                example: "EUR",
            }),
            net_cents: z.int().openapi({
                description:
                    "Nettobetrag der ersten Rechnung, in Cent. `0`, wenn keine " +
                    "ausgestellt wurde — etwa weil alles in der Testphase ist.",
                example: 2999,
            }),
            tax_cents: z.int().openapi({
                description:
                    "Steuerbetrag der ersten Rechnung, in Cent. Unter § 19 UStG 0.",
                example: 0,
            }),
            gross_cents: z.int().openapi({
                description: "Bruttobetrag der ersten Rechnung, in Cent.",
                example: 2999,
            }),
            payment_option: PAYMENT_OPTION,
            auto_charge: z.boolean().openapi({
                description:
                    "Ob wiederkehrende Beträge automatisch eingezogen werden dürfen.",
                example: false,
            }),
            invoice_id: z.string().nullable().openapi({
                description:
                    "Die erste Rechnung, falls eine ausgestellt wurde.",
                example: null,
            }),
            invoice_number: z.string().nullable().openapi({
                description: "Ihre Nummer.",
                example: "RE-2026-0012",
            }),
            terms_version: z
                .int()
                .nullable()
                .openapi({
                    description:
                        "Die Fassung der AGB, die bei der Bestellung galt. " +
                        "`null`, solange keine veröffentlicht ist und die " +
                        "eingebaute Fassung gilt.",
                    example: 3,
                }),
            terms_label: z.string().nullable().openapi({
                description: "Dieselbe Fassung in Worten, für Belege.",
                example: "Fassung 3, gültig ab 1. Oktober 2026",
            }),
            terms_accepted_at: z.iso.datetime().openapi({
                description: "Wann die AGB bestätigt wurden, in UTC.",
                example: "2026-11-07T10:00:00.000Z",
            }),
            withdrawal_accepted_at: z.iso
                .datetime()
                .nullable()
                .openapi({
                    description:
                        "Wann die Widerrufsbelehrung bestätigt wurde. `null` bei " +
                        "einer Firma, der kein Widerrufsrecht zusteht.",
                    example: "2026-11-07T10:00:00.000Z",
                }),
            is_consumer: z.boolean().openapi({
                description:
                    "Ob das Konto bei der Bestellung eine Privatperson war.",
                example: true,
            }),
            placed_at: z.iso.datetime().openapi({
                description: "Wann bestellt wurde, in UTC.",
                example: "2026-11-07T10:00:00.000Z",
            }),
            accepted_at: z.iso.datetime().nullable().openapi({
                description: "Wann die Bestellung angenommen wurde.",
                example: null,
            }),
            cancelled_at: z.iso.datetime().nullable().openapi({
                description: "Wann sie storniert oder abgelehnt wurde.",
                example: null,
            }),
            items: z.array(OrderItemSchema).openapi({
                description: "Die Positionen der Bestellung.",
            }),
            subscriptions: z.array(SubscriptionSchema).openapi({
                description:
                    "Die Abonnements, die daraus entstanden sind — eines je " +
                    "Abrechnungsrhythmus.",
            }),
            services: z.array(ServiceSchema).openapi({
                description: "Die Leistungen, die bereitzustellen sind.",
            }),
        })
        .openapi({
            description:
                "Eine Bestellung mit allem, was aus ihr entstanden ist: " +
                "Positionen, Abonnements, Leistungen und die erste Rechnung.",
        }),
);

const SECURITY = [{ [apiKeyAuth.name]: [] }];

registry.registerPath({
    method: "post",
    path: "/api/v1/orders",
    tags: ["Bestellungen"],
    summary: "Bestellung aufgeben",
    description:
        "Legt eine Bestellung an und führt sie in **einer** Transaktion aus: " +
        "Bestellung und Positionen, je Abrechnungsrhythmus ein Abonnement mit " +
        "eingefrorenen Preisen, für jede bereitzustellende Einheit eine " +
        "Leistung im Zustand `pending`, und die erste Rechnung, ausgestellt " +
        "mit fortlaufender Nummer und eingefrorenem Steuer-Snapshot. Fällt " +
        "heute nichts an — etwa weil alles in der Testphase ist —, wird gar " +
        "keine Rechnung ausgestellt statt einer über 0,00 €.\n\n" +
        "Jeder Preis wird dabei neu aus dem Katalog berechnet, von derselben " +
        "Funktion, die den Shop-Preis anzeigt. Ein Gutscheincode wird " +
        "eingelöst und zählt einmal je Bestellung.\n\n" +
        "Die Bestätigung der AGB ist Pflicht, bei einer Privatperson " +
        "zusätzlich die der Widerrufsbelehrung und das ausdrückliche " +
        "Verlangen nach § 356 Abs. 4 BGB. Die geltende Fassung der AGB wird " +
        "mit Zeitstempel an der Bestellung gespeichert. Benötigt " +
        "`orders.write`; ein Kundenschlüssel darf das für sein eigenes Konto.",
    security: SECURITY,
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: OrderCreateSchema } },
        },
    },
    responses: {
        201: {
            description: "Die angelegte Bestellung.",
            content: { "application/json": { schema: OrderSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/orders/{id}",
    tags: ["Bestellungen"],
    summary: "Bestellung ansehen",
    description:
        "Eine Bestellung mit ihren Positionen, den Abonnements und den " +
        "Leistungen, die aus ihr entstanden sind. Ein Kundenschlüssel sieht " +
        "nur die eigenen; eine fremde Bestellung wird mit 404 beantwortet und " +
        "nie mit 403, denn 403 würde bestätigen, dass es die ID gibt. " +
        "Benötigt `orders.read`.",
    security: SECURITY,
    request: {
        params: z.object({
            id: zId("order").openapi({
                param: { name: "id", in: "path" },
                description: "Die technische ID der Bestellung.",
            }),
        }),
    },
    responses: {
        200: {
            description: "Die Bestellung.",
            content: { "application/json": { schema: OrderSchema } },
        },
        ...PROBLEM_RESPONSES,
    },
});
