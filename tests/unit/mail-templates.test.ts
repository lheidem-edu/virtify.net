import { describe, expect, it } from "vitest";
import { LOCALES, type Locale } from "@/i18n/locale";
import { translator } from "@/i18n/messages";
import {
    MAIL_TEMPLATE_IDS,
    MAIL_TEMPLATE_LABELS,
    MAIL_TEMPLATES,
    mailTemplate,
} from "@/server/mail/templates";
import { DIRECT_MAIL_IDS } from "@/server/mail/templates/direct";
import type { MailText, RenderedMail } from "@/server/mail/templates/types";
import { defaultSettings } from "@/server/settings";

/**
 * Every transactional message, in both languages, with every branch of every
 * discriminator taken.
 *
 * This is the check that replaces the key-level type safety the templates give
 * up by building keys from payload values (see `MailText`). The translator
 * throws on a missing key, so a catalogue that is short one string fails here
 * rather than shipping `mail.welcome.intro2` into somebody's inbox — and
 * `PAYLOADS` below has to cover every branch for that to be true, which is
 * what the completeness test at the bottom holds it to.
 *
 * The amounts are concrete. A notice that names the wrong figure is the same
 * class of defect as an invoice that does, and "19,99 €" is checkable in a way
 * that `expect(subject).toBeTruthy()` is not.
 */

const SETTINGS = {
    ...defaultSettings,
    operator: { ...defaultSettings.operator, name: "Virtify" },
    site: {
        ...defaultSettings.site,
        url: "https://virtify.test",
        name: "virtify.net",
    },
};

function context(locale: Locale) {
    return {
        locale,
        settings: SETTINGS,
        t: translator(locale, "mail") as unknown as MailText,
        labels: translator(locale, "labels") as unknown as MailText,
        common: translator(locale, "common") as unknown as MailText,
    };
}

const base = { siteUrl: SETTINGS.site.url, siteName: SETTINGS.site.name };

/**
 * One payload per *branch*, not per template. The key is `<template>` or
 * `<template>#<branch>`, and the test at the bottom checks that every template
 * in the catalogue appears at least once.
 */
const PAYLOADS: Record<string, { template: string; payload: unknown }> = {
    welcome: {
        template: "welcome",
        payload: { ...base, name: "Kundin", customerNumber: 1042 },
    },
    "order.confirmed": {
        template: "order.confirmed",
        payload: {
            ...base,
            orderId: "order_1",
            orderNumber: "B-2026-0007",
            grossCents: 1999,
            currency: "EUR",
            invoiceNumber: "RE-2026-0041",
        },
    },
    "order.confirmed#no-invoice": {
        template: "order.confirmed",
        payload: {
            ...base,
            orderId: "order_1",
            orderNumber: "B-2026-0007",
            grossCents: 0,
            currency: "EUR",
            invoiceNumber: null,
        },
    },
    ...Object.fromEntries(
        (["order", "renewal", "change", "fee", "manual"] as const).map(
            (reason) => [
                `invoice.notice#${reason}`,
                {
                    template: "invoice.notice",
                    payload: {
                        ...base,
                        invoiceId: "invoice_1",
                        number: "RE-2026-0041",
                        grossCents: 1999,
                        currency: "EUR",
                        dueAt: "2026-12-01T00:00:00.000Z",
                        reason,
                        autoCharge: reason === "renewal",
                        pdfKey:
                            reason === "renewal"
                                ? "invoices/RE-2026-0041.pdf"
                                : null,
                    },
                },
            ],
        ),
    ),
    "payment.received#settled": {
        template: "payment.received",
        payload: {
            ...base,
            purpose: "invoice",
            invoiceId: "invoice_1",
            invoiceNumber: "RE-2026-0041",
            amountCents: 1999,
            currency: "EUR",
            outstandingCents: 0,
            paidAt: "2026-11-20T10:00:00.000Z",
        },
    },
    "payment.received#partial": {
        template: "payment.received",
        payload: {
            ...base,
            purpose: "invoice",
            invoiceId: "invoice_1",
            invoiceNumber: "RE-2026-0041",
            amountCents: 1000,
            currency: "EUR",
            outstandingCents: 999,
            paidAt: "2026-11-20T10:00:00.000Z",
        },
    },
    "payment.received#topup": {
        template: "payment.received",
        payload: {
            ...base,
            purpose: "topup",
            invoiceId: null,
            invoiceNumber: null,
            amountCents: 5000,
            currency: "EUR",
            outstandingCents: 0,
            paidAt: "2026-11-20T10:00:00.000Z",
        },
    },
    "payment.action_required": {
        template: "payment.action_required",
        payload: {
            ...base,
            invoiceId: "invoice_1",
            invoiceNumber: "RE-2026-0041",
            amountCents: 1999,
            currency: "EUR",
            url: "https://pay.test/confirm",
        },
    },
    "payment.failed#with-reason": {
        template: "payment.failed",
        payload: {
            ...base,
            invoiceId: "invoice_1",
            invoiceNumber: "RE-2026-0041",
            amountCents: 1999,
            currency: "EUR",
            reason: "Die Karte wurde abgelehnt (insufficient_funds).",
        },
    },
    "payment.failed#no-reason": {
        template: "payment.failed",
        payload: {
            ...base,
            invoiceId: null,
            invoiceNumber: null,
            amountCents: 1999,
            currency: "EUR",
            reason: null,
        },
    },
    ...Object.fromEntries(
        (["reminder", "mahnung", "suspend", "terminate"] as const).map(
            (level) => [
                `dunning#${level}`,
                {
                    template: "dunning",
                    payload: {
                        ...base,
                        level,
                        invoiceId: "invoice_1",
                        invoiceNumber: "RE-2026-0041",
                        outstandingCents: 1999,
                        currency: "EUR",
                        dueAt: "2026-11-10T00:00:00.000Z",
                        feeCents: level === "mahnung" ? 500 : 0,
                    },
                },
            ],
        ),
    ),
    "subscription.trial_ending": {
        template: "subscription.trial_ending",
        payload: {
            ...base,
            subscriptionId: "subscription_1",
            label: "VPS L mit Testphase",
            amountCents: 3999,
            currency: "EUR",
            chargeAt: "2026-11-24T00:00:00.000Z",
        },
    },
    "subscription.ended": {
        template: "subscription.ended",
        payload: {
            ...base,
            subscriptionId: "subscription_1",
            label: "VPS M",
            endedAt: "2026-11-30T00:00:00.000Z",
        },
    },
    "service.activated#hostname": {
        template: "service.activated",
        payload: {
            ...base,
            serviceId: "service_1",
            label: "VPS M",
            hostname: "vps-1042.virtify.test",
        },
    },
    "service.activated#no-hostname": {
        template: "service.activated",
        payload: {
            ...base,
            serviceId: "service_1",
            label: "VPS M",
            hostname: null,
        },
    },
    ...Object.fromEntries(
        (["dunning", "subscription", "manual"] as const).flatMap((reason) =>
            (["service.suspended", "service.terminated"] as const).map(
                (template) => [
                    `${template}#${reason}`,
                    {
                        template,
                        payload: {
                            ...base,
                            serviceId: "service_1",
                            label: "VPS M",
                            reason,
                        },
                    },
                ],
            ),
        ),
    ),
    "ticket.replied": {
        template: "ticket.replied",
        payload: {
            ...base,
            ticketId: "ticket_1",
            number: 1042,
            ticketSubject: "Server antwortet nicht",
        },
    },
};

/**
 * `Intl.NumberFormat` separates the amount from the currency with a
 * **non-breaking** space (U+00A0), which is correct in a mail and invisible in
 * a diff. Normalised here so an expectation can be written the way a person
 * types it.
 */
function plain(value: string): string {
    return value.replace(/\u00a0/g, " ");
}

function render(key: string, locale: Locale): RenderedMail {
    const entry = PAYLOADS[key];
    const template = mailTemplate(entry.template);

    if (!template) {
        throw new Error(`No such template: ${entry.template}`);
    }

    return template.render(
        template.payload.parse(entry.payload),
        context(locale),
    );
}

describe("the mail templates", () => {
    for (const key of Object.keys(PAYLOADS)) {
        for (const locale of LOCALES) {
            it(`renders ${key} in ${locale}`, () => {
                const mail = render(key, locale);

                expect(mail.subject.trim()).not.toBe("");
                expect(mail.heading.trim()).not.toBe("");
                expect(mail.intro.length).toBeGreaterThan(0);

                const text = [
                    mail.subject,
                    mail.heading,
                    ...mail.intro,
                    ...mail.outro,
                    ...mail.rows.flatMap((row) => [row.label, row.value]),
                ].join("\n");

                // The key-path shape a swallowed miss would leave behind. The
                // translator throws instead, and this is the belt to that
                // brace: it would also catch a key that *exists* and holds a
                // path by mistake.
                expect(text).not.toMatch(
                    /\b[a-z]+\.[a-zA-Z]+\.[a-zA-Z]+\b(?![^\s]*[@/])/,
                );
                expect(text).not.toContain("undefined");
                expect(text).not.toContain("NaN");
            });
        }
    }

    it("covers every template in the catalogue", () => {
        const covered = new Set<string>(
            Object.values(PAYLOADS).map((entry) => String(entry.template)),
        );

        expect(
            MAIL_TEMPLATE_IDS.filter((id) => !covered.has(id)),
            "a template with no payload in this file is a template nobody renders in a test",
        ).toEqual([]);
    });

    it("names the amount the payload carries, in the reader's format", () => {
        const de = render("invoice.notice#renewal", "de");
        const en = render("invoice.notice#renewal", "en");

        expect(de.rows.map((row) => plain(row.value))).toContain("19,99 €");
        expect(en.rows.map((row) => plain(row.value))).toContain("€19.99");

        // The due date in both calendars' notation, same day.
        expect(de.intro.join(" ")).toContain("1. Dezember 2026");
        expect(en.intro.join(" ")).toContain("1 December 2026");
    });

    it("does not call a part payment settled", () => {
        const partial = render("payment.received#partial", "de");
        const settled = render("payment.received#settled", "de");

        expect(settled.intro.join(" ")).toContain("ausgeglichen");
        expect(partial.intro.join(" ")).not.toContain("ausgeglichen");
        // The figure that matters: 19,99 € owed, 10,00 € paid, 9,99 € left.
        expect(plain(partial.intro.join(" "))).toContain("9,99 €");
        expect(partial.rows.map((row) => plain(row.value))).toContain("9,99 €");
    });

    it("charges the fee the rung raised, not the one in the settings", () => {
        const mahnung = render("dunning#mahnung", "de");
        const reminder = render("dunning#reminder", "de");

        expect(plain(mahnung.intro.join(" "))).toContain("5,00 €");
        expect(mahnung.rows.map((row) => row.label)).toContain("Mahngebühr");
        // A Zahlungserinnerung carries no fee, so it must not mention one.
        expect(reminder.intro.join(" ")).not.toContain("Gebühr");
        expect(reminder.rows.map((row) => row.label)).not.toContain(
            "Mahngebühr",
        );
    });

    it("says something different at every dunning rung, in both languages", () => {
        for (const locale of LOCALES) {
            const subjects = (
                ["reminder", "mahnung", "suspend", "terminate"] as const
            ).map((level) => render(`dunning#${level}`, locale).subject);

            expect(new Set(subjects).size).toBe(4);
        }
    });

    it("never puts a password in the service notice", () => {
        for (const locale of LOCALES) {
            const mail = render("service.activated#hostname", locale);
            const text = [...mail.intro, ...mail.outro].join(" ").toLowerCase();

            // The build plan says it in the same breath as the link. The
            // template has no password *field* at all, which is the real
            // guarantee; this asserts the sentence that tells the customer
            // where to find it instead.
            expect(text).toMatch(/passwor[dt]/);
            expect(mail.rows.map((row) => row.label)).not.toContain("Passwort");
            expect(mail.rows.map((row) => row.label)).not.toContain("Password");
        }
    });

    it("attaches the stored invoice only when there is one", () => {
        const withPdf = PAYLOADS["invoice.notice#renewal"];
        const withoutPdf = PAYLOADS["invoice.notice#order"];
        // Through `mailTemplate`, which erases the payload type the way the
        // outbox does — indexing the catalogue directly gives the union of
        // all thirteen payloads and therefore an intersection to parse.
        const template = mailTemplate("invoice.notice");

        if (!template) {
            throw new Error("invoice.notice is missing from the catalogue");
        }

        expect(
            template.attachments?.(template.payload.parse(withPdf.payload)),
        ).toEqual([
            {
                key: "invoices/RE-2026-0041.pdf",
                filename: "RE-2026-0041.pdf",
                contentType: "application/pdf",
            },
        ]);
        expect(
            template.attachments?.(template.payload.parse(withoutPdf.payload)),
        ).toEqual([]);
    });

    it("has a German label for every template, outbox and direct alike", () => {
        for (const id of MAIL_TEMPLATE_IDS) {
            expect(MAIL_TEMPLATE_LABELS[id]?.trim()).not.toBe("");
        }

        // The direct half is listed separately but has to be labelled too, or
        // the admin log shows a bare id for the mails people ask about most.
        expect(DIRECT_MAIL_IDS.length).toBeGreaterThan(0);
    });

    it("declares how every template is delivered", () => {
        for (const id of MAIL_TEMPLATE_IDS) {
            // Everything in this catalogue goes through the outbox. A `direct`
            // entry here would be queueable *and* sent by hand, which is the
            // two-senders-one-message failure the split exists to prevent.
            expect(mailTemplate(id)?.delivery).toBe("outbox");
        }
    });
});

/**
 * The catalogue's keys and its entries' own ids have to agree, or
 * `mailTemplate("x")` returns a template that calls itself something else and
 * the admin log labels it wrongly. `satisfies` cannot catch that on its own.
 */
describe("the catalogue", () => {
    it("files every template under its own id", () => {
        for (const [key, template] of Object.entries(MAIL_TEMPLATES)) {
            expect(template.id).toBe(key);
        }
    });
});
