import "server-only";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/db";
import { bank, billing, operator, policy, revenue, site } from "@/lib/site";

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
        /** Steuernummer — § 14 Abs. 4 Nr. 2 UStG wants it or the USt-IdNr. */
        taxNumber: string;
        phone: string;
    };
    bank: { name: string; iban: string; bic: string };
    policy: {
        logRetentionDays: number;
        paymentTermDays: number;
        dataRetrievalDays: number;
        securityMaintenanceNoticeHours: number;
        /** 1–28, or 0 to bill on the day of the order. */
        billingAnchorDay: number;
    };
    revenue: {
        kleinunternehmerPreviousLimitCents: number;
        kleinunternehmerCurrentLimitCents: number;
        basis: RevenueBasis;
    };
    /** Phase 6: the recurring run, the retry ladder and dunning. */
    billing: BillingPolicy;
};

export type BillingPolicy = {
    renewalLeadDays: number;
    /** Days after the due date an auto-charge is attempted on. */
    collectionRetryDays: number[];
    dunningReminderDays: number;
    dunningMahnungDays: number;
    dunningSuspendDays: number;
    dunningTerminateDays: number;
    dunningFeeCents: number;
};

/** Which date a paid invoice counts towards a calendar year. */
export type RevenueBasis = "service" | "invoice" | "payment";

export const REVENUE_BASES: RevenueBasis[] = ["service", "invoice", "payment"];

export const REVENUE_BASIS_LABEL: Record<RevenueBasis, string> = {
    service: "Leistungsdatum",
    invoice: "Rechnungsdatum",
    payment: "Zahlungseingang",
};

function revenueBasis(value: string): RevenueBasis {
    return (REVENUE_BASES as string[]).includes(value)
        ? (value as RevenueBasis)
        : "service";
}

export const defaultSettings: Settings = {
    site,
    operator: { ...operator },
    bank,
    policy,
    revenue: { ...revenue, basis: revenueBasis(revenue.basis) },
    billing: {
        ...billing,
        collectionRetryDays: [...billing.collectionRetryDays],
    },
};

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
            taxNumber: row.operatorTaxNumber ?? "",
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
            billingAnchorDay: row.billingAnchorDay,
        },
        revenue: {
            kleinunternehmerPreviousLimitCents:
                row.kleinunternehmerPreviousLimitCents,
            kleinunternehmerCurrentLimitCents:
                row.kleinunternehmerCurrentLimitCents,
            basis: revenueBasis(row.revenueBasis),
        },
        billing: {
            renewalLeadDays: row.renewalLeadDays,
            /**
             * An empty ladder would mean "never collect anything", which is
             * never what an operator means by clearing a field — it is what
             * a failed migration or a bad form looks like. The default is
             * the safer reading.
             */
            collectionRetryDays:
                row.collectionRetryDays.length > 0
                    ? [...row.collectionRetryDays].sort((a, b) => a - b)
                    : [...billing.collectionRetryDays],
            dunningReminderDays: row.dunningReminderDays,
            dunningMahnungDays: row.dunningMahnungDays,
            dunningSuspendDays: row.dunningSuspendDays,
            dunningTerminateDays: row.dunningTerminateDays,
            dunningFeeCents: row.dunningFeeCents,
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
        operatorTaxNumber: settings.operator.taxNumber,
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
