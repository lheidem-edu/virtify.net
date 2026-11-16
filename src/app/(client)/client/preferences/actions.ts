"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { db, schema } from "@/db";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALES } from "@/i18n/locale";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, THEMES } from "@/lib/theme";
import { audit } from "@/server/audit";
import { requestOrigin } from "@/server/audit/request";
import { getCurrentCustomer } from "@/server/customers/current";

/**
 * The two preferences a reader gets to set.
 *
 * **Language is written twice and that is on purpose.** The cookie is what a
 * request without a session reads, and `customer.language` is what the
 * *account* speaks — it decides the language of their mail and of any later
 * session on another machine. Writing only the cookie would give a customer a
 * German invoice notice after they switched the portal to English; writing
 * only the column would lose the choice for anyone not signed in.
 *
 * The column is a state change on a customer record, so it is audited
 * (rule 8). The cookie is not: it is this browser's own preference and
 * belongs to nobody but the person holding it.
 *
 * **Theme is a cookie only.** It is a property of the screen in front of
 * somebody, not of the account — the same person on a phone in daylight and a
 * desktop at night wants two different answers, and an account-wide setting
 * would make them fight.
 */

export type PreferenceState = {
    status: "idle" | "ok" | "error";
    message?: string;
};

const localeSchema = z.object({ locale: z.enum(LOCALES) });
const themeSchema = z.object({ theme: z.enum(THEMES) });

export async function setLocale(
    _previous: PreferenceState,
    data: FormData,
): Promise<PreferenceState> {
    const parsed = localeSchema.safeParse({ locale: data.get("locale") });

    if (!parsed.success) {
        return { status: "error", message: "Unbekannte Sprache." };
    }

    const { customer, user } = await getCurrentCustomer();

    (await cookies()).set(LOCALE_COOKIE, parsed.data.locale, {
        path: "/",
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: "lax",
        httpOnly: false,
    });

    if (customer.language !== parsed.data.locale) {
        await db
            .update(schema.customer)
            .set({ language: parsed.data.locale, updatedAt: new Date() })
            .where(eq(schema.customer.id, customer.id));

        const origin = await requestOrigin();

        await audit(db, {
            actor: { type: "customer", id: user.id, label: user.email },
            action: "customer.update",
            entityType: "customer",
            entityId: customer.id,
            before: { language: customer.language },
            after: { language: parsed.data.locale },
            ip: origin.ip,
            userAgent: origin.userAgent,
        });
    }

    // The whole portal, because the locale decides every string on it.
    revalidatePath("/client", "layout");

    return { status: "ok" };
}

export async function setTheme(
    _previous: PreferenceState,
    data: FormData,
): Promise<PreferenceState> {
    const parsed = themeSchema.safeParse({ theme: data.get("theme") });

    if (!parsed.success) {
        return { status: "error", message: "Unbekannte Darstellung." };
    }

    // No session required: the theme is nobody's data. A visitor reading the
    // storefront gets to turn the lights on too.
    (await cookies()).set(THEME_COOKIE, parsed.data.theme, {
        path: "/",
        maxAge: THEME_COOKIE_MAX_AGE,
        sameSite: "lax",
        /**
         * Readable by script on purpose: the inline head script reads this
         * cookie to reconcile `system` with the machine *before the first
         * paint*, and a script that has to wait for the server to tell it the
         * answer is the flash this exists to prevent.
         */
        httpOnly: false,
    });

    revalidatePath("/", "layout");

    return { status: "ok" };
}
