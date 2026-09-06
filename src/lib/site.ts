/**
 * Single source of truth for the operator details that appear in the
 * Impressum, the Datenschutzerklärung and the AGB. Change it here, not in
 * the individual legal pages.
 */
export const site = {
    name: "virtify.net",
    url: "https://virtify.net",
    /** Shown under the wordmark in the footer. */
    tagline: "Hosting-Anbieter aus Augustdorf, mit Herz und eigener Hardware.",
    description:
        "Virtuelle Maschinen unter Proxmox VE, betrieben auf eigener Hardware in Augustdorf.",
} as const;

export const operator = {
    name: "Luca Heidemann",
    street: "Hermann-Löns-Weg 19",
    city: "32832 Augustdorf",
    country: "Deutschland",
    email: "admin@virtify.net",
    /** Held for intra-EU transactions; the § 19 UStG scheme still applies. */
    vatId: "DE457809315",
    /** Printed on invoices and offers. Deliberately absent from the
     *  Impressum, where only the email address is given. */
    phone: "+49 (0) 171 4100695",
} as const;

/** Payment details, printed in the document footer. */
export const bank = {
    name: "C24 Bank GmbH",
    iban: "DE64 5002 4024 8341 7339 30",
    bic: "DEFFDEFFXXX",
} as const;

/** Operational values referenced by the legal texts. */
export const policy = {
    /** Retention of web server access logs, in days. */
    logRetentionDays: 14,
    /** Default payment term after invoice date, in days. */
    paymentTermDays: 14,
    /** Minimum window after contract end during which data stays retrievable. */
    dataRetrievalDays: 14,
    /** Minimum notice for urgent security maintenance, in hours. */
    securityMaintenanceNoticeHours: 24,
} as const;

/** Commit the running build was produced from — see next.config.ts. */
export const commit = process.env.NEXT_PUBLIC_COMMIT ?? "unbekannt";

/** Rendered as "Stand: …" at the top of every legal document. */
export const legalUpdated = "6. September 2026";
