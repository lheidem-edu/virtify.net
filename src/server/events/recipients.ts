import { asc, eq, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { type Locale, toLocale } from "@/i18n/locale";

/**
 * Who hears about a customer's events.
 *
 * ## Only `select`
 *
 * The handle is narrowed to `select` and that is the point: this module runs
 * inside the dispatcher, which runs inside the event bus, and the one rule
 * that keeps the bus from becoming a second settlement path is that nothing
 * downstream of an event can write. A notifier that could `update` would
 * eventually be asked to "just mark the invoice paid while you are there".
 *
 * ## Which contacts, and why not the one who caused it
 *
 * A notification goes to the people the *account* knows about, filtered by
 * what each contact is there for: a Steuerberater who holds `can_billing` on
 * two accounts gets those accounts' invoices, and the technical contact who
 * does not hold it does not. Never to whoever happened to trigger the thing —
 * Phase 7 learned that one the hard way with ticket replies, where answering
 * the last sender turns a guessed ticket number into somebody else's support
 * history.
 *
 * A contact with no relevant permission at all still gets nothing rather
 * than everything: an account whose only billing contact was removed is a
 * problem for a person to notice, not a reason to mail the technical contact
 * an invoice.
 */

type Reader = Pick<typeof defaultDb, "select">;

export type Recipient = {
    email: string;
    name: string | null;
    locale: Locale;
};

/** Which of the three sub-permissions a message belongs to. */
export type Audience = "billing" | "technical" | "tickets" | "any";

/**
 * Everyone on the account who should receive a message of this kind.
 *
 * Ordered owner first, then by id: a stable order means the fan-out writes
 * its `email_log` rows in the same sequence on a retry, which is only
 * cosmetic — each row is keyed on its own address — but makes a log of a
 * half-finished dispatch readable.
 */
export async function recipientsFor(
    db: Reader,
    customerId: string,
    audience: Audience = "billing",
): Promise<Recipient[]> {
    const rows = await db
        .select({
            email: schema.customerContact.email,
            role: schema.customerContact.role,
            canBilling: schema.customerContact.canBilling,
            canTechnical: schema.customerContact.canTechnical,
            canTickets: schema.customerContact.canTickets,
            userName: schema.user.name,
            language: schema.customer.language,
            status: schema.customer.status,
        })
        .from(schema.customerContact)
        .innerJoin(
            schema.customer,
            eq(schema.customerContact.customerId, schema.customer.id),
        )
        .leftJoin(
            schema.user,
            eq(schema.customerContact.userId, schema.user.id),
        )
        .where(eq(schema.customerContact.customerId, customerId))
        .orderBy(
            sql`case when ${schema.customerContact.role} = 'owner' then 0 else 1 end`,
            asc(schema.customerContact.id),
        );

    return rows
        .filter((row) => {
            /**
             * A closed account is not written to. It is closed because
             * nothing runs any more or because it was anonymised, and in the
             * second case the address in this row is no longer a person's.
             */
            if (row.status === "closed") {
                return false;
            }

            if (audience === "any") {
                return true;
            }

            // The owner holds all three and cannot lose them (Phase 1), so
            // this reads as "the owner always qualifies" without a special
            // case.
            return audience === "billing"
                ? row.canBilling
                : audience === "technical"
                  ? row.canTechnical
                  : row.canTickets;
        })
        .map((row) => ({
            email: row.email,
            name: row.userName ?? null,
            locale: toLocale(row.language),
        }));
}

/**
 * The address a document names as its recipient, where it names one.
 *
 * An invoice carries `buyer_email` — a snapshot of where it was sent, taken
 * when it was finalized — and that wins over today's contact list for
 * anything *about that document*. Rule 3 again, in a different costume: a
 * finalized invoice does not change, including in who it was for.
 */
export async function invoiceRecipient(
    db: Reader,
    invoiceId: string,
): Promise<Recipient | null> {
    const [row] = await db
        .select({
            email: schema.invoice.buyerEmail,
            name: schema.invoice.buyerName,
            language: schema.customer.language,
        })
        .from(schema.invoice)
        .innerJoin(
            schema.customer,
            eq(schema.invoice.customerId, schema.customer.id),
        )
        .where(eq(schema.invoice.id, invoiceId))
        .limit(1);

    if (!row?.email) {
        return null;
    }

    return {
        email: row.email,
        name: row.name ?? null,
        locale: toLocale(row.language),
    };
}
