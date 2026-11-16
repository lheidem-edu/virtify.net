/**
 * Which languages the product speaks, and how one is chosen.
 *
 * Framework-free on purpose: the request config, the mail renderer (which
 * runs in the worker, a plain Node process) and the tests all import this,
 * and anything that reached into Next here would stop the worker dead.
 *
 * ## German is the default, and that is a rule rather than an ordering
 *
 * Rule 13: German is the product language. English is beside it, not in
 * front of it — invoice wording, legal texts and the operator's own copy
 * stay German whatever the browser asks for, and a locale this module cannot
 * recognise is German rather than a guess.
 *
 * ## There is no locale in the URL
 *
 * Every link in every mail this installation has ever sent points at
 * `/client/invoices/<id>`, the AGB in force name those paths, and
 * `next.config.ts` already keeps `/account/*` alive for exactly that reason.
 * A locale segment would either break them or need a second redirect layer
 * for every one. So the locale is a property of the *reader* — the signed-in
 * customer's `language`, then their cookie, then what their browser asked
 * for — and never of the address.
 */

export const LOCALES = ["de", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "de";

/** The cookie the switcher writes. `NEXT_LOCALE` is next-intl's own name. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** A year: the choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
    return (
        typeof value === "string" &&
        (LOCALES as readonly string[]).includes(value)
    );
}

/** Falls back rather than throwing: a stale cookie must not break a page. */
export function toLocale(value: unknown): Locale {
    return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * The best match for an `Accept-Language` header.
 *
 * Deliberately simple — quality values in order, primary subtag only, first
 * supported one wins. The full RFC 4647 lookup is what `@formatjs`'s matcher
 * does and it is already in the tree through next-intl, but it is not
 * reachable from the worker and this is two lines of behaviour: `de-AT` is
 * German, `en-GB` is English, and anything else is German because that is
 * the default rather than a tie-break.
 */
export function localeFromAcceptLanguage(header: string | null): Locale | null {
    if (!header) {
        return null;
    }

    const ranked = header
        .split(",")
        .map((part) => {
            const [tag, ...params] = part.trim().split(";");
            const q = params
                .map((entry) => entry.trim())
                .find((entry) => entry.startsWith("q="));

            return {
                tag: (tag ?? "").trim().toLowerCase(),
                // A range with no q is q=1 (RFC 9110 §12.4.2). An unparseable
                // one is 0, so `q=nonsense` does not outrank a real
                // preference.
                q: q ? Number.parseFloat(q.slice(2)) || 0 : 1,
            };
        })
        .filter((entry) => entry.tag.length > 0 && entry.q > 0)
        .sort((a, b) => b.q - a.q);

    for (const entry of ranked) {
        const primary = entry.tag.split("-")[0];

        if (isLocale(primary)) {
            return primary;
        }
    }

    return null;
}

/** What a language is called, in its own language. For the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
    de: "Deutsch",
    en: "English",
};
