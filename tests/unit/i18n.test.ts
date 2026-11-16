import { describe, expect, it } from "vitest";
import {
    DEFAULT_LOCALE,
    isLocale,
    LOCALES,
    localeFromAcceptLanguage,
    toLocale,
} from "@/i18n/locale";
import { MESSAGES, translator } from "@/i18n/messages";

/**
 * The two catalogues, and the one rule that keeps them honest.
 *
 * German is the product language (rule 13) and is therefore the source: `de`
 * defines the key set and `en` has to match it exactly. A key missing from
 * `en` is an English mail with `mail.welcome.intro2` in the body, and
 * TypeScript cannot see it — the message files are JSON, and only the keys
 * this code names are checked.
 */

function flatten(value: unknown, prefix = ""): string[] {
    if (typeof value !== "object" || value === null) {
        return [prefix];
    }

    return Object.entries(value).flatMap(([key, child]) =>
        flatten(child, prefix ? `${prefix}.${key}` : key),
    );
}

describe("the message catalogue", () => {
    it("has the same keys in both languages", () => {
        const de = flatten(MESSAGES.de).sort();
        const en = flatten(MESSAGES.en).sort();

        expect(en.filter((key) => !de.includes(key))).toEqual([]);
        expect(de.filter((key) => !en.includes(key))).toEqual([]);
    });

    it("has no empty string anywhere", () => {
        for (const locale of LOCALES) {
            const empty = flatten(MESSAGES[locale]).filter((path) => {
                const value = path
                    .split(".")
                    .reduce<unknown>(
                        (node, key) => (node as Record<string, unknown>)?.[key],
                        MESSAGES[locale],
                    );

                return typeof value !== "string" || value.trim() === "";
            });

            expect(empty, `${locale} has empty messages`).toEqual([]);
        }
    });

    it("throws on a key that is not there rather than printing it", () => {
        const t = translator("de", "mail");

        // The default in `use-intl` is to swallow the miss and render the key
        // path. For a mail that is the difference between a late message and
        // a wrong one, so the translator is built with `onError` throwing —
        // and the outbox treats the throw as a failed render.
        expect(() => t("welcome.nope" as never)).toThrow();
    });

    it("interpolates", () => {
        expect(
            translator("de", "mail")("welcome.intro1", { name: "Welt" }),
        ).toBe("Hallo Welt,");
        expect(
            translator("en", "mail")("welcome.intro1", { name: "World" }),
        ).toBe("Hello World,");
    });

    it("picks the plural form the count asks for", () => {
        const t = translator("de", "portal");

        expect(t("dashboard.invoicesOpen", { count: 0 })).toBe("Nichts offen");
        expect(t("dashboard.invoicesOpen", { count: 1 })).toBe("1 offen");
        expect(t("dashboard.invoicesOpen", { count: 4 })).toBe("4 offen");
    });
});

describe("choosing a locale", () => {
    it("defaults to German", () => {
        expect(DEFAULT_LOCALE).toBe("de");
        expect(toLocale(undefined)).toBe("de");
        expect(toLocale("fr")).toBe("de");
        expect(toLocale("en")).toBe("en");
    });

    it("knows what it speaks", () => {
        expect(isLocale("de")).toBe(true);
        expect(isLocale("en")).toBe(true);
        expect(isLocale("en-GB")).toBe(false);
        expect(isLocale(null)).toBe(false);
    });

    it("negotiates Accept-Language by quality, primary subtag only", () => {
        expect(localeFromAcceptLanguage("de-AT,de;q=0.9")).toBe("de");
        expect(localeFromAcceptLanguage("en-GB,en;q=0.9")).toBe("en");
        // The order in the header is not the order of preference; q is.
        expect(localeFromAcceptLanguage("en;q=0.3,de;q=0.8")).toBe("de");
        expect(localeFromAcceptLanguage("de;q=0.3,en;q=0.8")).toBe("en");
        // A range with no q is q=1 and outranks an explicit 0.9.
        expect(localeFromAcceptLanguage("en,de;q=0.9")).toBe("en");
        // q=0 means "not acceptable" and must not be chosen.
        expect(localeFromAcceptLanguage("de;q=0,en;q=0.1")).toBe("en");
    });

    it("gives up rather than guessing", () => {
        expect(localeFromAcceptLanguage(null)).toBeNull();
        expect(localeFromAcceptLanguage("")).toBeNull();
        expect(localeFromAcceptLanguage("fr-FR,it;q=0.8")).toBeNull();
    });
});
