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
    /**
     * Steuernummer. § 14 Abs. 4 Nr. 2 UStG wants the Steuernummer or the
     * USt-IdNr. on every invoice; the operator holds both, and the admin
     * settings page is where the real one is entered.
     */
    taxNumber: "",
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
    /**
     * Day of the month every subscription is billed on, 1–28; `0` bills on
     * the day of the order. See the settings schema.
     */
    billingAnchorDay: 0,
} as const;

/**
 * The recurring billing run: when a renewal is invoiced, when it is
 * collected, and what happens when it is not paid. All of them are settings
 * in the database — these are only what a fresh installation starts with.
 *
 * Every figure is days after the relevant date, and every one of them is a
 * rung that is climbed at most once per invoice: the unique indexes on
 * `invoice_collection` and `dunning_action` are what make that true, not the
 * fact that the run reads these numbers.
 */
export const billing = {
    /** Days before a period starts that its invoice is raised. */
    renewalLeadDays: 14,
    /** Days after the due date an auto-charge is attempted on. */
    collectionRetryDays: [0, 3, 7],
    /** Days after the due date each dunning rung falls on. */
    dunningReminderDays: 3,
    dunningMahnungDays: 10,
    dunningSuspendDays: 14,
    dunningTerminateDays: 30,
    /** Mahngebühr in cents; 0 raises none. */
    dunningFeeCents: 0,
} as const;

/**
 * § 19 UStG. The scheme applies while the previous calendar year stayed under
 * the first figure and the current year stays under the second; exceeding the
 * current-year limit ends it from that transaction on. Both are settings in
 * the database — these are only what a fresh installation starts with.
 */
export const revenue = {
    kleinunternehmerPreviousLimitCents: 2_500_000,
    kleinunternehmerCurrentLimitCents: 10_000_000,
    /** `service` | `invoice` | `payment` — see the settings schema. */
    basis: "service",
} as const;

/** Commit the running build was produced from — see next.config.ts. */
export const commit = process.env.NEXT_PUBLIC_COMMIT ?? "unbekannt";

/** Rendered as "Stand: …" at the top of every legal document. */
export const legalUpdated = "7. September 2026";
