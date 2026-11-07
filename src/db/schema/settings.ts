import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Everything the operator can change in the admin area that used to live in
 * src/lib/site.ts. One row, merged over the defaults in that file.
 */

/**
 * The operator's own details — everything the Impressum, the invoices and the
 * legal texts quote. One row, because there is one operator; the defaults in
 * src/lib/site.ts apply until it exists, so a fresh database still serves a
 * complete site.
 */
export const siteSetting = pgTable("site_setting", {
    id: text("id").primaryKey(),

    siteName: text("site_name").notNull(),
    siteUrl: text("site_url").notNull(),
    tagline: text("tagline").notNull(),
    description: text("description").notNull(),

    operatorName: text("operator_name").notNull(),
    operatorStreet: text("operator_street").notNull(),
    operatorCity: text("operator_city").notNull(),
    operatorCountry: text("operator_country").notNull(),
    operatorEmail: text("operator_email").notNull(),
    operatorVatId: text("operator_vat_id").notNull(),
    /**
     * Steuernummer. § 14 Abs. 4 Nr. 2 UStG wants one of the two on every
     * invoice, and a Kleinunternehmer commonly has only this one. Nullable
     * because an installation may genuinely hold only a USt-IdNr.
     */
    operatorTaxNumber: text("operator_tax_number"),
    operatorPhone: text("operator_phone").notNull(),

    bankName: text("bank_name").notNull(),
    bankIban: text("bank_iban").notNull(),
    bankBic: text("bank_bic").notNull(),

    logRetentionDays: integer("log_retention_days").notNull(),
    paymentTermDays: integer("payment_term_days").notNull(),
    dataRetrievalDays: integer("data_retrieval_days").notNull(),
    securityMaintenanceNoticeHours: integer(
        "security_maintenance_notice_hours",
    ).notNull(),

    /**
     * § 19 UStG threshold monitor. The limits are settings because the law
     * has moved them before (17 500 € → 22 000 € → 25 000 €) and an operator
     * should not need a deployment to follow it.
     */
    kleinunternehmerPreviousLimitCents: integer(
        "kleinunternehmer_previous_limit_cents",
    )
        .notNull()
        .default(2_500_000),
    kleinunternehmerCurrentLimitCents: integer(
        "kleinunternehmer_current_limit_cents",
    )
        .notNull()
        .default(10_000_000),
    /**
     * Which date a paid invoice counts towards a year: `service` the start of
     * its Leistungszeitraum, `invoice` its Rechnungsdatum, `payment` the day
     * the money arrived. The § 19 Gesamtumsatz is a cash figure, so `payment`
     * is the strict reading; `service` is the default because that is how the
     * operator's own books are kept and it is what the build plan asks for.
     */
    revenueBasis: text("revenue_basis").notNull().default("service"),

    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
