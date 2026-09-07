import "server-only";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/lib/db";
import { bank, operator, policy, site } from "@/lib/site";

/**
 * The operator's details, from the database when they have been edited and
 * from src/lib/site.ts until then. Both halves exist on purpose: the file is
 * what makes a fresh database serve a complete site, and the row is what lets
 * the operator change an address without a deployment.
 *
 * Cached per request, so the twenty places that quote the address in one
 * rendered invoice do not become twenty queries.
 */

export const SETTINGS_ID = "singleton";

export type Settings = {
    site: { name: string; url: string; tagline: string; description: string };
    operator: {
        name: string;
        street: string;
        city: string;
        country: string;
        email: string;
        vatId: string;
        phone: string;
    };
    bank: { name: string; iban: string; bic: string };
    policy: {
        logRetentionDays: number;
        paymentTermDays: number;
        dataRetrievalDays: number;
        securityMaintenanceNoticeHours: number;
    };
};

export const defaultSettings: Settings = { site, operator, bank, policy };

export const loadSettings = cache(async (): Promise<Settings> => {
    let row: typeof schema.siteSetting.$inferSelect | undefined;

    try {
        [row] = await db
            .select()
            .from(schema.siteSetting)
            .where(eq(schema.siteSetting.id, SETTINGS_ID));
    } catch (error) {
        // A page must still render when the database is briefly unreachable;
        // the built-in details are correct, just not editable.
        console.error("[settings] falling back to the defaults:", error);
        return defaultSettings;
    }

    if (!row) {
        return defaultSettings;
    }

    return {
        site: {
            name: row.siteName,
            url: row.siteUrl,
            tagline: row.tagline,
            description: row.description,
        },
        operator: {
            name: row.operatorName,
            street: row.operatorStreet,
            city: row.operatorCity,
            country: row.operatorCountry,
            email: row.operatorEmail,
            vatId: row.operatorVatId,
            phone: row.operatorPhone,
        },
        bank: {
            name: row.bankName,
            iban: row.bankIban,
            bic: row.bankBic,
        },
        policy: {
            logRetentionDays: row.logRetentionDays,
            paymentTermDays: row.paymentTermDays,
            dataRetrievalDays: row.dataRetrievalDays,
            securityMaintenanceNoticeHours: row.securityMaintenanceNoticeHours,
        },
    };
});

/** The flat map the legal texts substitute their placeholders from. */
export function legalValues(settings: Settings) {
    return {
        siteName: settings.site.name,
        siteUrl: settings.site.url,
        tagline: settings.site.tagline,
        description: settings.site.description,

        operatorName: settings.operator.name,
        operatorStreet: settings.operator.street,
        operatorCity: settings.operator.city,
        operatorCountry: settings.operator.country,
        operatorEmail: settings.operator.email,
        operatorVatId: settings.operator.vatId,
        operatorPhone: settings.operator.phone,

        bankName: settings.bank.name,
        bankIban: settings.bank.iban,
        bankBic: settings.bank.bic,

        logRetentionDays: settings.policy.logRetentionDays,
        paymentTermDays: settings.policy.paymentTermDays,
        dataRetrievalDays: settings.policy.dataRetrievalDays,
        securityMaintenanceNoticeHours:
            settings.policy.securityMaintenanceNoticeHours,
    };
}

/** The placeholders an editor may use, for the help text beside the field. */
export const LEGAL_PLACEHOLDERS = Object.keys(
    legalValues(defaultSettings),
) as (keyof ReturnType<typeof legalValues>)[];
