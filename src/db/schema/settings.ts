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

    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
