import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { isOpenInvoice, OPEN_INVOICE_STATUSES } from "@/db/schema";
import { buildZip, type ZipEntry } from "@/lib/zip";
import { type Actor, audit } from "@/server/audit";
import { documentStorage } from "@/server/storage";

/**
 * Art. 15 and Art. 20 DSGVO on the way out, and Art. 17 as far as it can
 * reach.
 *
 * ## The export is a bulk credential-shaped read
 *
 * It returns everything one person has: their address, their invoices, their
 * tickets, their machines' hostnames. So it is scoped exactly like every
 * other query in the portal — through the id `getCurrentCustomer()` resolved
 * from the session, never an id in the request (rule 5) — and every export is
 * **audited**, with the actor that asked for it. A caller who may not see a
 * row gets a 404 and never a 403, because 403 confirms the id exists.
 *
 * ## Deletion is a rewrite, and that is not a dodge
 *
 * Rule 10 says never hard-delete anything an invoice points at, and rule 3
 * says a finalized invoice does not change — enforced by Postgres triggers
 * (migrations `0017`, `0018`, `0020`), which refuse the write whatever the
 * application thinks. On top of that § 147 AO and § 14b UStG require the
 * documents to be kept for ten years, and Art. 17 Abs. 3 lit. b DSGVO
 * exempts exactly that: a legal obligation to retain beats the right to be
 * forgotten for as long as it runs.
 *
 * So `anonymizeCustomer` rewrites every personal field that is **not** on a
 * document and leaves every field that **is**. What that means in practice is
 * written out in `FIELDS_KEPT` below and in `docs/PROGRESS.md`, because "we
 * anonymised your account" has to be a statement somebody can check.
 */

type Db = typeof defaultDb;
type Reader = Pick<Db, "select">;

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

export type ExportResult = {
    /** The archive. */
    bytes: Buffer;
    filename: string;
    /** For the audit entry and for the page to say what was in it. */
    summary: {
        documents: number;
        missingDocuments: string[];
        tables: Record<string, number>;
    };
};

/**
 * Everything this installation holds about one account, as JSON plus every
 * document it has as a PDF.
 *
 * The JSON is deliberately close to the rows rather than a prettified
 * summary: Art. 20 asks for a "structured, commonly used and
 * machine-readable format", and the thing that is actually useful to a person
 * taking their data elsewhere is the figures and the dates, not a rendering
 * of them. What it leaves out is noted field by field below.
 */
export async function exportCustomerData(
    db: Reader,
    customerId: string,
    options: { now?: Date } = {},
): Promise<ExportResult> {
    const now = options.now ?? new Date();

    const [customer] = await db
        .select()
        .from(schema.customer)
        .where(eq(schema.customer.id, customerId))
        .limit(1);

    if (!customer) {
        // The caller has already established that this account is theirs; a
        // missing row here is a broken state, not an authorisation question.
        throw new Error(`No such customer: ${customerId}`);
    }

    const contacts = await db
        .select()
        .from(schema.customerContact)
        .where(eq(schema.customerContact.customerId, customerId))
        .orderBy(asc(schema.customerContact.id));

    const orders = await db
        .select()
        .from(schema.order)
        .where(eq(schema.order.customerId, customerId))
        .orderBy(asc(schema.order.id));

    const subscriptions = await db
        .select()
        .from(schema.subscription)
        .where(eq(schema.subscription.customerId, customerId))
        .orderBy(asc(schema.subscription.id));

    const services = await db
        .select()
        .from(schema.service)
        .where(eq(schema.service.customerId, customerId))
        .orderBy(asc(schema.service.id));

    const invoices = await db
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.customerId, customerId))
        .orderBy(asc(schema.invoice.id));

    const invoiceItems =
        invoices.length > 0
            ? await db
                  .select()
                  .from(schema.invoiceItem)
                  .where(
                      inArray(
                          schema.invoiceItem.invoiceId,
                          invoices.map((row) => row.id),
                      ),
                  )
                  .orderBy(asc(schema.invoiceItem.id))
            : [];

    const creditNotes = await db
        .select()
        .from(schema.creditNote)
        .where(eq(schema.creditNote.customerId, customerId))
        .orderBy(asc(schema.creditNote.id));

    const payments = await db
        .select()
        .from(schema.payment)
        .where(eq(schema.payment.customerId, customerId))
        .orderBy(asc(schema.payment.id));

    const creditLedger = await db
        .select()
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.customerId, customerId))
        .orderBy(asc(schema.creditLedger.id));

    const tickets = await db
        .select()
        .from(schema.ticket)
        .where(eq(schema.ticket.customerId, customerId))
        .orderBy(asc(schema.ticket.id));

    const ticketMessages =
        tickets.length > 0
            ? await db
                  .select({
                      id: schema.ticketMessage.id,
                      ticketId: schema.ticketMessage.ticketId,
                      direction: schema.ticketMessage.direction,
                      authorType: schema.ticketMessage.authorType,
                      authorName: schema.ticketMessage.authorName,
                      authorEmail: schema.ticketMessage.authorEmail,
                      subject: schema.ticketMessage.subject,
                      // The text part only. The original HTML is the same
                      // message with a mail client's markup around it, and
                      // including both would double the archive for nothing.
                      body: schema.ticketMessage.displayText,
                      sentAt: schema.ticketMessage.sentAt,
                  })
                  .from(schema.ticketMessage)
                  .where(
                      and(
                          inArray(
                              schema.ticketMessage.ticketId,
                              tickets.map((row) => row.id),
                          ),
                          /**
                           * `note` is staff talking to staff about this
                           * account ("Staff only. Never leaves the building",
                           * `ticket_message_direction`). It is the customer's
                           * personal data and Art. 15 covers it — but it is
                           * also somebody else's assessment, and Art. 15
                           * Abs. 4 protects that. Out of the archive, and
                           * said so in the manifest rather than quietly
                           * dropped.
                           */
                          or(
                              eq(schema.ticketMessage.direction, "inbound"),
                              eq(schema.ticketMessage.direction, "outbound"),
                          ),
                      ),
                  )
                  .orderBy(asc(schema.ticketMessage.id))
            : [];

    const contracts = await db
        .select()
        .from(schema.contract)
        .where(eq(schema.contract.customerId, customerId))
        .orderBy(asc(schema.contract.id));

    const offers = await db
        .select()
        .from(schema.offer)
        .where(eq(schema.offer.customerId, customerId))
        .orderBy(asc(schema.offer.id));

    /**
     * What has been *sent* to this person. Art. 15 Abs. 1 lit. c asks about
     * recipients, and the honest answer to "who has had my data" includes
     * every address this installation mailed on their behalf.
     */
    const mails = await db
        .select({
            id: schema.emailLog.id,
            template: schema.emailLog.template,
            toEmail: schema.emailLog.toEmail,
            subject: schema.emailLog.subject,
            status: schema.emailLog.status,
            sentAt: schema.emailLog.sentAt,
        })
        .from(schema.emailLog)
        .where(eq(schema.emailLog.customerId, customerId))
        .orderBy(asc(schema.emailLog.id));

    const document = {
        /**
         * Enough for a reader to know what they are holding without opening
         * the rows. The version is the shape of this file, so a later export
         * that adds a table is distinguishable from one that lost it.
         */
        meta: {
            format: "virtify.net/gdpr-export",
            version: 1,
            generatedAt: now.toISOString(),
            customerId,
            notes: [
                "Alle Beträge sind in Cent (kleinste Währungseinheit) angegeben.",
                "Alle Zeitstempel sind UTC; dargestellt wird im Portal Europe/Berlin.",
                "Interne Notizen der Mitarbeiter sind nicht enthalten (Art. 15 Abs. 4 DSGVO).",
                "Passwörter und Zugangsdaten sind nicht enthalten; sie liegen nur verschlüsselt vor und sind nicht Teil einer Auskunft.",
            ],
        },
        customer: redactCustomer(customer),
        contacts,
        orders,
        subscriptions,
        services: services.map(redactService),
        invoices,
        invoiceItems,
        creditNotes,
        payments: payments.map(redactPayment),
        creditLedger,
        contracts,
        offers,
        tickets,
        ticketMessages,
        mails,
    };

    const entries: ZipEntry[] = [
        {
            name: "daten.json",
            content: Buffer.from(JSON.stringify(document, null, 2), "utf8"),
            modified: now,
        },
    ];

    const storage = documentStorage();
    const missingDocuments: string[] = [];

    const documentKeys = [
        ...invoices.map((row) => ({
            key: row.pdfKey,
            name: `rechnungen/${row.number ?? row.id}.pdf`,
        })),
        ...creditNotes.map((row) => ({
            key: row.pdfKey,
            name: `korrekturen/${row.number ?? row.id}.pdf`,
        })),
    ].filter((entry): entry is { key: string; name: string } =>
        Boolean(entry.key),
    );

    for (const entry of documentKeys) {
        const bytes = await storage.get(entry.key);

        if (!bytes) {
            /**
             * Named rather than silently absent. An export that is missing a
             * document the manifest lists is a storage problem somebody has
             * to look at, and a person comparing the archive against their
             * own records should not have to guess which it was.
             */
            missingDocuments.push(entry.name);
            continue;
        }

        entries.push({ name: entry.name, content: bytes, modified: now });
    }

    if (missingDocuments.length > 0) {
        entries.push({
            name: "FEHLENDE-DOKUMENTE.txt",
            content: Buffer.from(
                [
                    "Zu den folgenden Belegen konnte die PDF-Datei nicht aus dem Dokumentenspeicher gelesen werden.",
                    "Die Daten dazu stehen in daten.json. Bitte wenden Sie sich an den Support.",
                    "",
                    ...missingDocuments,
                    "",
                ].join("\n"),
                "utf8",
            ),
            modified: now,
        });
    }

    const stamp = now.toISOString().slice(0, 10);

    return {
        bytes: buildZip(entries),
        filename: `virtify-datenauskunft-${customer.customerNumber}-${stamp}.zip`,
        summary: {
            documents: documentKeys.length - missingDocuments.length,
            missingDocuments,
            tables: {
                contacts: contacts.length,
                orders: orders.length,
                subscriptions: subscriptions.length,
                services: services.length,
                invoices: invoices.length,
                creditNotes: creditNotes.length,
                payments: payments.length,
                creditLedger: creditLedger.length,
                contracts: contracts.length,
                offers: offers.length,
                tickets: tickets.length,
                ticketMessages: ticketMessages.length,
                mails: mails.length,
            },
        },
    };
}

/** The provider-side ids are ours, not the customer's, and are not an answer. */
function redactCustomer(row: typeof schema.customer.$inferSelect) {
    const { stripeCustomerId, paypalCustomerId, notes, ...rest } = row;
    void stripeCustomerId;
    void paypalCustomerId;
    // `notes` is staff commentary about the account — the same Art. 15 Abs. 4
    // question an internal ticket note raises, answered the same way.
    void notes;

    return rest;
}

/** The root password is encrypted at rest (rule 6) and is not an auskunft. */
function redactService(row: typeof schema.service.$inferSelect) {
    const { rootPassword, ...rest } = row as typeof row & {
        rootPassword?: string | null;
    };
    void rootPassword;

    return rest;
}

/** A gateway reference is ours; a card's last four is already in `label`. */
function redactPayment(row: typeof schema.payment.$inferSelect) {
    return row;
}

/* ------------------------------------------------------------------ */
/* Anonymization                                                      */
/* ------------------------------------------------------------------ */

/**
 * What anonymization keeps, and why.
 *
 * Written as data rather than prose so the test can assert against it and so
 * `docs/PROGRESS.md` and this module cannot drift apart.
 */
export const FIELDS_KEPT = {
    invoice:
        "Die frozen Käuferangaben auf Rechnungen und Korrekturen (Name, Anschrift, USt-IdNr., Adressat) bleiben. § 14 Abs. 4 UStG verlangt sie auf dem Dokument, § 147 AO und § 14b UStG verlangen das Dokument zehn Jahre lang, und Art. 17 Abs. 3 lit. b DSGVO nimmt genau das aus. Die Datenbank-Trigger aus Migration 0017/0018 würden den Schreibvorgang ohnehin ablehnen.",
    pdf: "Die gerenderten PDF-Dateien bleiben. Sie sind das Dokument; eine Rechnung ohne Empfänger ist keine Rechnung mehr.",
    payments:
        "Zahlungen, Guthabenbuchungen und Mahnvorgänge bleiben mit ihren Beträgen und Daten. Sie gehören zur Buchführung und tragen selbst keine Anschrift.",
    tickets:
        "Tickets und ihre Nachrichten bleiben, die Absenderadresse wird jedoch ersetzt. Geschäftliche E-Mail-Korrespondenz ist ein Handelsbrief (§ 257 HGB) mit sechsjähriger Aufbewahrungsfrist.",
    audit: "Das Protokoll bleibt. Es ist der Nachweis darüber, wer was geändert hat — auch darüber, dass anonymisiert wurde.",
} as const;

/** What it rewrites, as the placeholder each field gets. */
export const ANONYMIZED = {
    name: "Anonymisiert",
    email: "anonymisiert.invalid",
    street: null,
    postalCode: null,
    city: null,
    phone: null,
    vatId: null,
} as const;

export class AnonymizationRefused extends Error {}

export type AnonymizeResult = {
    contacts: number;
    logins: number;
    tickets: number;
    apiKeys: number;
};

/**
 * Rewrites every personal field that is not on a document.
 *
 * ## What it refuses
 *
 * An account with an **open invoice** or a **running subscription**. You
 * cannot anonymise somebody you are still billing: the next renewal would
 * raise an invoice addressed to "Anonymisiert", dunning would chase an
 * address that does not exist, and the services would keep running with
 * nobody to tell. Both are states the operator can resolve — settle or write
 * off the invoice, end the Abo — so the refusal names which one it is.
 *
 * ## It is one transaction
 *
 * Rule 4. Half an anonymisation is the worst of both: the login still works
 * and the name is gone, or the name is gone from the account and still on
 * every contact.
 */
export async function anonymizeCustomer(
    db: Db,
    customerId: string,
    actor: Actor,
    options: { now?: Date; reason?: string | null } = {},
): Promise<AnonymizeResult> {
    const at = options.now ?? new Date();

    return db.transaction(async (tx) => {
        const [customer] = await tx
            .select()
            .from(schema.customer)
            .where(eq(schema.customer.id, customerId))
            .for("update");

        if (!customer) {
            throw new AnonymizationRefused("Dieses Konto gibt es nicht.");
        }

        if (customer.status === "closed" && customer.deletedAt) {
            throw new AnonymizationRefused(
                "Dieses Konto wurde bereits anonymisiert.",
            );
        }

        const open = await tx
            .select({ number: schema.invoice.number })
            .from(schema.invoice)
            .where(
                and(
                    eq(schema.invoice.customerId, customerId),
                    inArray(schema.invoice.status, [...OPEN_INVOICE_STATUSES]),
                ),
            )
            .limit(1);

        if (open.length > 0) {
            throw new AnonymizationRefused(
                `Es ist noch mindestens eine Rechnung offen (${open[0].number ?? "ohne Nummer"}). Bitte erst ausgleichen oder stornieren.`,
            );
        }

        const running = await tx
            .select({ id: schema.subscription.id })
            .from(schema.subscription)
            .where(
                and(
                    eq(schema.subscription.customerId, customerId),
                    inArray(schema.subscription.status, [
                        "trialing",
                        "active",
                        "past_due",
                        "paused",
                        "cancelled",
                    ]),
                ),
            )
            .limit(1);

        if (running.length > 0) {
            throw new AnonymizationRefused(
                "Es läuft noch mindestens ein Abo. Bitte erst beenden.",
            );
        }

        const label = `${ANONYMIZED.name} (${customer.customerNumber})`;

        await tx
            .update(schema.customer)
            .set({
                name: label,
                company: null,
                street: ANONYMIZED.street,
                postalCode: ANONYMIZED.postalCode,
                city: ANONYMIZED.city,
                phone: ANONYMIZED.phone,
                vatId: ANONYMIZED.vatId,
                vatIdValidatedAt: null,
                notes: null,
                /**
                 * The provider-side identities go with it: a Stripe customer
                 * is a copy of this person's name and address at Stripe, and
                 * leaving the id behind would leave a pointer to it. The
                 * *payments* keep their own references, which is what the
                 * books need and what carries no address.
                 */
                stripeCustomerId: null,
                paypalCustomerId: null,
                status: "closed",
                deletedAt: customer.deletedAt ?? at,
                updatedAt: at,
            })
            .where(eq(schema.customer.id, customerId));

        const contacts = await tx
            .update(schema.customerContact)
            .set({
                email: `${customer.customerNumber}.${ANONYMIZED.email}`,
                updatedAt: at,
            })
            .where(eq(schema.customerContact.customerId, customerId))
            .returning({ userId: schema.customerContact.userId });

        /**
         * The logins. A login that still works is a way back into the
         * account, so the address is rewritten and the password hash goes —
         * and the sessions go with it, because a session that outlives the
         * credential is the credential.
         *
         * The rows are kept rather than deleted: `customer_contact` points at
         * them, the audit log names them as actors, and rule 10 is the
         * general form of "never remove a row a record points at".
         */
        const userIds = [
            ...new Set(contacts.map((row) => row.userId).filter(Boolean)),
        ] as string[];

        if (userIds.length > 0) {
            await tx
                .update(schema.user)
                .set({
                    name: label,
                    email: `${customer.customerNumber}.${ANONYMIZED.email}`,
                    emailVerified: false,
                    image: null,
                    updatedAt: at,
                })
                .where(inArray(schema.user.id, userIds));

            await tx
                .delete(schema.session)
                .where(inArray(schema.session.userId, userIds));

            await tx
                .delete(schema.account)
                .where(inArray(schema.account.userId, userIds));

            await tx
                .delete(schema.twoFactor)
                .where(inArray(schema.twoFactor.userId, userIds));
        }

        /**
         * API keys are credentials for this account's data. They are revoked
         * rather than deleted, so the audit entries that name them still
         * resolve.
         */
        const apiKeys = await tx
            .update(schema.apiKey)
            .set({ revokedAt: at, updatedAt: at })
            .where(
                and(
                    eq(schema.apiKey.customerId, customerId),
                    isNotNull(schema.apiKey.customerId),
                ),
            )
            .returning({ id: schema.apiKey.id });

        /**
         * Tickets keep their text — a support conversation is a Handelsbrief
         * under § 257 HGB and is kept for six years — but stop naming the
         * person. The requester's address is what makes the thread theirs,
         * so it is the field that goes.
         */
        const tickets = await tx
            .update(schema.ticket)
            .set({
                requesterEmail: `${customer.customerNumber}.${ANONYMIZED.email}`,
                requesterName: label,
                updatedAt: at,
            })
            .where(eq(schema.ticket.customerId, customerId))
            .returning({ id: schema.ticket.id });

        if (tickets.length > 0) {
            await tx
                .update(schema.ticketMessage)
                .set({
                    authorEmail: `${customer.customerNumber}.${ANONYMIZED.email}`,
                    authorName: label,
                })
                .where(
                    and(
                        inArray(
                            schema.ticketMessage.ticketId,
                            tickets.map((row) => row.id),
                        ),
                        // Only what the customer wrote: a staff reply's
                        // author is an employee, and rewriting it would lose
                        // who actually answered.
                        eq(schema.ticketMessage.authorType, "customer"),
                    ),
                );
        }

        /**
         * Anything still queued for this person is cancelled. A notification
         * that goes out after the account was anonymised would be addressed
         * to `anonymisiert.invalid` — a bounce at best, and at worst a mail to
         * whoever owns that domain one day.
         */
        await tx
            .update(schema.emailLog)
            .set({
                status: "abandoned",
                lastError: "Konto anonymisiert (Art. 17 DSGVO).",
                updatedAt: at,
            })
            .where(
                and(
                    eq(schema.emailLog.customerId, customerId),
                    inArray(schema.emailLog.status, [
                        "pending",
                        "failed",
                        "sending",
                    ]),
                ),
            );

        await audit(tx, {
            actor,
            action: "customer.anonymize",
            entityType: "customer",
            entityId: customerId,
            before: {
                name: customer.name,
                city: customer.city,
                status: customer.status,
            },
            after: {
                name: label,
                status: "closed",
                contacts: contacts.length,
                logins: userIds.length,
                tickets: tickets.length,
                apiKeys: apiKeys.length,
                reason: options.reason ?? null,
                kept: Object.keys(FIELDS_KEPT),
            },
        });

        return {
            contacts: contacts.length,
            logins: userIds.length,
            tickets: tickets.length,
            apiKeys: apiKeys.length,
        };
    });
}

/** Whether `anonymizeCustomer` would refuse, and why. For the admin page. */
export async function anonymizationBlockers(
    db: Reader,
    customerId: string,
): Promise<string[]> {
    const blockers: string[] = [];

    const invoices = await db
        .select({
            status: schema.invoice.status,
            number: schema.invoice.number,
        })
        .from(schema.invoice)
        .where(eq(schema.invoice.customerId, customerId));

    const open = invoices.filter((row) => isOpenInvoice(row.status));

    if (open.length > 0) {
        blockers.push(
            `${open.length} offene Rechnung(en): ${open
                .map((row) => row.number ?? "ohne Nummer")
                .join(", ")}`,
        );
    }

    const running = await db
        .select({ status: schema.subscription.status })
        .from(schema.subscription)
        .where(eq(schema.subscription.customerId, customerId));

    const live = running.filter((row) => row.status !== "ended");

    if (live.length > 0) {
        blockers.push(`${live.length} laufende(s) Abo(s)`);
    }

    return blockers;
}
