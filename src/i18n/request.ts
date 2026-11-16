import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
    DEFAULT_LOCALE,
    isLocale,
    LOCALE_COOKIE,
    type Locale,
    localeFromAcceptLanguage,
} from "./locale";
import { messagesFor } from "./messages";

/**
 * Which language this request is answered in.
 *
 * In order, and the order is the point:
 *
 *  1. **The signed-in customer's `language`.** It is a field on the billing
 *     account and it is what their invoices and their mail already use. A
 *     portal that renders in English while the invoice attached to the mail
 *     is German would be the worse kind of half-translation.
 *  2. **The `NEXT_LOCALE` cookie.** What a visitor picked before signing in,
 *     and what a customer's switcher writes alongside the account field — so
 *     a second browser on the same account still follows the account.
 *  3. **`Accept-Language`.** A first visit with no preference expressed.
 *  4. **German**, because rule 13 says German is the product language and an
 *     unrecognised locale is not a reason to guess.
 *
 * There is no locale in the URL; see `./locale.ts` for why.
 *
 * The customer lookup is deliberately guarded: this runs for *every* request
 * under the app, including the ones with no session and the ones served
 * while the database is unreachable, and a request config that throws takes
 * the whole page with it. A language is never worth a 500.
 */
async function resolveLocale(): Promise<Locale> {
    try {
        const { getSession } = await import("@/server/auth/session");
        const session = await getSession();

        if (session) {
            const { db } = await import("@/db");
            const { customerForUser } = await import(
                "@/server/customers/repository"
            );
            const row = await customerForUser(db, session.user.id);

            if (row && isLocale(row.customer.language)) {
                return row.customer.language;
            }
        }
    } catch {
        // No session, no database, or not in a request scope at all.
    }

    try {
        const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;

        if (isLocale(cookie)) {
            return cookie;
        }

        const accept = (await headers()).get("accept-language");
        const negotiated = localeFromAcceptLanguage(accept);

        if (negotiated) {
            return negotiated;
        }
    } catch {
        // Rendered outside a request (a static page, a build-time pass).
    }

    return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
    const locale = await resolveLocale();

    return {
        locale,
        messages: messagesFor(locale),
        /**
         * Everything this product shows a date in is Berlin time (rule 9),
         * including for the customer reading it from somewhere else: an
         * invoice due "on the 30th" is due on the 30th in Berlin, and a
         * formatter that quietly used the viewer's zone would move it.
         */
        timeZone: "Europe/Berlin",
    };
});
