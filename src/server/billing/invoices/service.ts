import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { add, subtract } from "@/lib/money";
import { createId } from "@/lib/ulid";
import { type Actor, audit } from "@/server/audit";
import { nextNumber } from "@/server/documents/numbering";
import {
    formatRecipient,
    freezeBuyer,
    loadBuyer,
} from "@/server/documents/repository";
import { resettleInvoice } from "@/server/payments/apply";
import { loadSettings, type Settings } from "@/server/settings";
import { TaxDeterminationError } from "@/server/tax/types";
import { creditedQuantities } from "./repository";
import { determineTax } from "./tax-context";
import { calculateTotals, type TaxedLineInput } from "./totals";

/**
 * The invoice lifecycle: draft → finalize → paid, and corrections by credit
 * note. Everything here takes the executor as a parameter and holds no React,
 * so the admin actions, the API routes and the tests all drive the same code.
 *
 * The one rule that shapes the rest: **a finalized invoice is never written
 * to again**, except for the three facts that are about the invoice rather
 * than on it — whether it has been paid, how much of it has been credited,
 * and where its rendered PDF lives. The service refuses anything else, and a
 * Postgres trigger refuses it a second time for everything that does not come
 * through the service at all.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export type InvoiceErrorCode =
    | "not-found"
    | "not-draft"
    | "no-items"
    | "contract-mismatch"
    | "tax"
    | "not-finalized"
    | "not-creditable"
    | "over-credit"
    | "not-unpaid"
    | "not-paid";

export class InvoiceError extends Error {
    constructor(
        readonly code: InvoiceErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "InvoiceError";
    }
}

export type InvoiceItemInput = {
    description: string;
    detail?: string | null;
    quantity: number;
    unitCode: string;
    unitPriceCents: number;
    servicePeriodStart?: Date | null;
    servicePeriodEnd?: Date | null;
    /**
     * The Abo position this line bills, where it bills one. A note about
     * where the line came from, never a price — see the column's comment in
     * `src/db/schema/invoices.ts`.
     */
    subscriptionItemId?: string | null;
};

export type InvoiceDraftInput = {
    customerId: string;
    contractId?: string | null;
    introText?: string | null;
    note?: string | null;
    servicePeriodStart?: Date | null;
    servicePeriodEnd?: Date | null;
    items: InvoiceItemInput[];
};

/**
 * A contract may only be billed to the account it belongs to. The picker
 * lists every contract, so without this an invoice could carry another
 * customer's contract into its PDF and onto that contract's detail page.
 */
async function assertContractBelongsTo(
    tx: Executor,
    contractId: string | null | undefined,
    customerId: string,
) {
    if (!contractId) {
        return;
    }

    const [contract] = await tx
        .select({ customerId: schema.contract.customerId })
        .from(schema.contract)
        .where(eq(schema.contract.id, contractId));

    if (contract?.customerId !== customerId) {
        throw new InvoiceError(
            "contract-mismatch",
            "Der Vertrag gehört zu einem anderen Konto.",
        );
    }
}

function itemRows(invoiceId: string, items: InvoiceItemInput[]) {
    return items.map((item, index) => ({
        id: createId("invoiceitem"),
        invoiceId,
        position: index + 1,
        description: item.description,
        detail: item.detail ?? null,
        quantity: item.quantity,
        unitCode: item.unitCode,
        unitPriceCents: item.unitPriceCents,
        servicePeriodStart: item.servicePeriodStart ?? null,
        servicePeriodEnd: item.servicePeriodEnd ?? null,
        subscriptionItemId: item.subscriptionItemId ?? null,
    }));
}

export async function createInvoiceDraft(
    db: Db,
    input: InvoiceDraftInput,
    actor: Actor,
) {
    return db.transaction((tx) => createInvoiceDraftIn(tx, input, actor));
}

/**
 * The same thing inside a transaction the caller already owns.
 *
 * The checkout needs the order, the subscriptions, the services and the
 * first invoice to commit together or not at all (rule 4), and an invoice
 * that opened a transaction of its own would commit on its own. Everything
 * in this module therefore has an `…In(tx)` form, and the exported
 * convenience wrappers are nothing but `db.transaction(…)` around it.
 */
export async function createInvoiceDraftIn(
    tx: Tx,
    input: InvoiceDraftInput,
    actor: Actor,
) {
    if (input.items.length === 0) {
        throw new InvoiceError(
            "no-items",
            "Die Rechnung hat keine Positionen.",
        );
    }

    const id = createId("invoice");

    // Checked rather than left to the foreign key, so an unknown or
    // soft-deleted account produces a sentence instead of a 500.
    const [customer] = await tx
        .select({ id: schema.customer.id })
        .from(schema.customer)
        .where(
            and(
                eq(schema.customer.id, input.customerId),
                isNull(schema.customer.deletedAt),
            ),
        );

    if (!customer) {
        throw new InvoiceError(
            "not-found",
            "Dieses Kundenkonto gibt es nicht.",
        );
    }

    await assertContractBelongsTo(tx, input.contractId, input.customerId);

    const [row] = await tx
        .insert(schema.invoice)
        .values({
            id,
            customerId: input.customerId,
            contractId: input.contractId ?? null,
            status: "draft",
            introText: input.introText ?? null,
            note: input.note ?? null,
            servicePeriodStart: input.servicePeriodStart ?? null,
            servicePeriodEnd: input.servicePeriodEnd ?? null,
        })
        .returning();

    await tx.insert(schema.invoiceItem).values(itemRows(id, input.items));

    await audit(tx, {
        actor,
        action: "invoice.create",
        entityType: "invoice",
        entityId: id,
        after: {
            customerId: input.customerId,
            contractId: input.contractId ?? null,
            positions: input.items.length,
        },
    });

    return row;
}

/**
 * The only mutable state an invoice ever has. Positions are deleted and
 * reinserted rather than diffed: the loaders order by `position`, and a full
 * rewrite is what keeps that sequence dense.
 */
export async function updateInvoiceDraft(
    db: Db,
    invoiceId: string,
    input: InvoiceDraftInput,
    actor: Actor,
) {
    if (input.items.length === 0) {
        throw new InvoiceError(
            "no-items",
            "Die Rechnung hat keine Positionen.",
        );
    }

    return db.transaction(async (tx) => {
        const row = await lockInvoice(tx, invoiceId);

        if (row.status !== "draft") {
            throw new InvoiceError(
                "not-draft",
                "Nur Entwürfe können bearbeitet werden.",
            );
        }

        await assertContractBelongsTo(tx, input.contractId, input.customerId);

        // Items first, invoice second — the same order finalize uses, and the
        // order the immutability trigger requires once a row leaves `draft`.
        await tx
            .delete(schema.invoiceItem)
            .where(eq(schema.invoiceItem.invoiceId, invoiceId));

        await tx
            .insert(schema.invoiceItem)
            .values(itemRows(invoiceId, input.items));

        const [updated] = await tx
            .update(schema.invoice)
            .set({
                customerId: input.customerId,
                contractId: input.contractId ?? null,
                introText: input.introText ?? null,
                note: input.note ?? null,
                servicePeriodStart: input.servicePeriodStart ?? null,
                servicePeriodEnd: input.servicePeriodEnd ?? null,
                updatedAt: new Date(),
            })
            .where(eq(schema.invoice.id, invoiceId))
            .returning();

        await audit(tx, {
            actor,
            action: "invoice.update",
            entityType: "invoice",
            entityId: invoiceId,
            after: {
                customerId: input.customerId,
                contractId: input.contractId ?? null,
                positions: input.items.length,
            },
        });

        return updated;
    });
}

/**
 * A draft carries no number, so deleting it burns nothing and leaves no gap
 * in the RE- series that § 14 Abs. 4 Nr. 4 UStG requires to be unbroken.
 * Anything finalized is kept for the § 257 HGB / § 147 AO retention period
 * and corrected by a Rechnungskorrektur instead.
 */
export async function deleteInvoiceDraft(
    db: Db,
    invoiceId: string,
    actor: Actor,
) {
    return db.transaction(async (tx) => {
        const row = await lockInvoice(tx, invoiceId);

        if (row.status !== "draft") {
            throw new InvoiceError(
                "not-draft",
                "Nur Entwürfe können gelöscht werden.",
            );
        }

        // invoice_item cascades, so the positions go with the row.
        await tx.delete(schema.invoice).where(eq(schema.invoice.id, invoiceId));

        await audit(tx, {
            actor,
            action: "invoice.delete",
            entityType: "invoice",
            entityId: invoiceId,
            before: { customerId: row.customerId },
        });
    });
}

async function lockInvoice(tx: Executor, invoiceId: string) {
    const [row] = await tx
        .select()
        .from(schema.invoice)
        .where(eq(schema.invoice.id, invoiceId))
        .for("update");

    if (!row) {
        throw new InvoiceError("not-found", "Diese Rechnung gibt es nicht.");
    }

    return row;
}

/** What the seller block on a finalized document is frozen from. */
export function freezeSeller(settings: Settings) {
    return {
        sellerName: settings.operator.name,
        sellerStreet: settings.operator.street,
        sellerCity: settings.operator.city,
        sellerCountry: settings.operator.country,
        sellerEmail: settings.operator.email,
        sellerPhone: settings.operator.phone,
        sellerVatId: settings.operator.vatId || null,
        sellerTaxNumber: settings.operator.taxNumber || null,
        sellerBankName: settings.bank.name,
        sellerIban: settings.bank.iban,
        sellerBic: settings.bank.bic,
    };
}

export type FinalizeOptions = {
    /** Overridden in tests and by the 20-parallel-finalize case. */
    now?: Date;
    settings?: Settings;
    /** Days until the invoice falls due; the policy setting by default. */
    paymentTermDays?: number;
    /**
     * The due date outright, where the caller knows it better than a count
     * of days does. A renewal invoice is raised a fortnight *ahead* of the
     * period it bills and falls due on the day that period starts — term
     * days from today would make it due before the service exists, and
     * dunning is reckoned from this date.
     */
    dueAt?: Date;
};

/**
 * The point of no return.
 *
 * Inside one transaction: the tax strategy in force at this instant is
 * resolved and applied to every line, the seller and the buyer are frozen
 * onto the row, the totals are computed, and the gapless number required by
 * § 14 Abs. 4 Nr. 4 UStG is taken from `document_counter` under the row lock
 * its upsert holds — so two concurrent finalizations serialise instead of
 * colliding.
 *
 * The PDF is deliberately *not* rendered in here. Rendering takes a few
 * hundred milliseconds and would hold the number counter's lock for every one
 * of them, turning a burst of renewals into a queue. It is written
 * immediately afterwards, write-once, and can be produced again from the
 * frozen row at any time — see `invoicePdf()`.
 */
export async function finalizeInvoice(
    db: Db,
    invoiceId: string,
    actor: Actor,
    options: FinalizeOptions = {},
) {
    const resolved = await resolveFinalizeOptions(options);

    return db.transaction((tx) =>
        finalizeInvoiceIn(tx, invoiceId, actor, resolved),
    );
}

/** Everything `finalizeInvoiceIn` must be told rather than look up itself. */
export type ResolvedFinalizeOptions = {
    at: Date;
    settings: Settings;
    termDays: number;
    /** Wins over `termDays` where the caller named one. */
    dueAt?: Date | null;
};

/**
 * Loads what the finalization needs *before* the transaction opens. Reading
 * the settings inside it would hold the number counter's row lock across a
 * query that has nothing to do with numbering.
 */
export async function resolveFinalizeOptions(
    options: FinalizeOptions = {},
): Promise<ResolvedFinalizeOptions> {
    const settings = options.settings ?? (await loadSettings());

    return {
        at: options.now ?? new Date(),
        settings,
        termDays: options.paymentTermDays ?? settings.policy.paymentTermDays,
        dueAt: options.dueAt ?? null,
    };
}

/**
 * Finalization inside a transaction the caller already owns — the form the
 * checkout uses, so the order and its first invoice commit together.
 */
export async function finalizeInvoiceIn(
    tx: Tx,
    invoiceId: string,
    actor: Actor,
    resolved: ResolvedFinalizeOptions,
) {
    const { at, settings, termDays } = resolved;

    const row = await lockInvoice(tx, invoiceId);

    if (row.status !== "draft") {
        throw new InvoiceError(
            "not-draft",
            "Nur Entwürfe können ausgestellt werden.",
        );
    }

    const items = await tx
        .select()
        .from(schema.invoiceItem)
        .where(eq(schema.invoiceItem.invoiceId, invoiceId))
        .orderBy(asc(schema.invoiceItem.position));

    if (items.length === 0) {
        throw new InvoiceError(
            "no-items",
            "Eine Rechnung ohne Positionen kann nicht ausgestellt werden.",
        );
    }

    const buyer = await loadBuyer(row.customerId, tx);

    let determined: Awaited<ReturnType<typeof determineTax>>;

    try {
        determined = await determineTax(tx, buyer, settings, at);
    } catch (error) {
        // A strategy that cannot decide stops the finalization rather
        // than guessing a rate onto a legal document.
        if (error instanceof TaxDeterminationError) {
            throw new InvoiceError("tax", error.message);
        }

        throw error;
    }

    const { strategy, determination, notes } = determined;

    const lines: TaxedLineInput[] = items.map((item) => ({
        description: item.description,
        detail: item.detail,
        quantity: item.quantity,
        unitCode: item.unitCode,
        unitPriceCents: item.unitPriceCents,
        taxRateBp: determination.rateBp,
        taxCategory: determination.category,
        taxRule: determination.rule,
        servicePeriodStart: item.servicePeriodStart,
        servicePeriodEnd: item.servicePeriodEnd,
    }));

    const totals = calculateTotals(lines);

    // The lines are written before the invoice leaves `draft`: once it
    // has, the trigger on invoice_item refuses every write to them.
    for (const [index, item] of items.entries()) {
        await tx
            .update(schema.invoiceItem)
            .set({
                taxStrategy: strategy.id,
                taxRateBp: determination.rateBp,
                taxCategory: determination.category,
                taxRule: determination.rule,
                netCents: totals.lines[index].netCents,
            })
            .where(eq(schema.invoiceItem.id, item.id));
    }

    /**
     * Never before the day it was issued. A renewal raised late — a worker
     * that was down, a run that failed and was repeated — would otherwise
     * arrive already overdue and be dunned the same afternoon.
     */
    const dueAt =
        resolved.dueAt && resolved.dueAt.getTime() > at.getTime()
            ? resolved.dueAt
            : new Date(at.getTime() + termDays * 86_400_000);
    const number = await nextNumber(tx, "invoice", at);

    const [finalized] = await tx
        .update(schema.invoice)
        .set({
            number,
            status: "unpaid",
            issuedAt: at,
            dueAt,
            recipient: formatRecipient(buyer, settings.operator.country),
            buyerReference:
                buyer.buyerReference ??
                String(buyer.customerNumber ?? buyer.id),
            buyerCustomerNumber: buyer.customerNumber,
            ...freezeBuyer(buyer),
            ...freezeSeller(settings),
            taxStrategy: strategy.id,
            taxNote: notes.join(" ") || null,
            netCents: totals.netCents,
            taxCents: totals.taxCents,
            grossCents: totals.grossCents,
            updatedAt: at,
        })
        .where(eq(schema.invoice.id, invoiceId))
        .returning();

    await audit(tx, {
        actor,
        action: "invoice.finalize",
        entityType: "invoice",
        entityId: invoiceId,
        before: { status: "draft", number: null },
        after: {
            status: "unpaid",
            number,
            taxStrategy: strategy.id,
            taxRule: determination.rule,
            taxRateBp: determination.rateBp,
            netCents: totals.netCents,
            taxCents: totals.taxCents,
            grossCents: totals.grossCents,
        },
    });

    return { invoice: finalized, totals, number };
}

export type CreditNoteInput = {
    invoiceId: string;
    /** `full` reverses everything that is left; `partial` takes named lines. */
    kind: "full" | "partial";
    reason?: string | null;
    /** Required for a partial correction: which line, and how much of it. */
    lines?: { invoiceItemId: string; quantity: number }[];
};

/**
 * A correction is never an edit. AGB § 7 (7): "Eine ausgestellte Rechnung
 * wird nicht verändert. Korrekturen erfolgen durch Stornierung und
 * Neuausstellung." So a Rechnungskorrektur is a document of its own, numbered
 * from its own gapless range, pointing at the invoice it credits.
 *
 * Everything it says about tax is copied from the invoice's own lines, never
 * re-determined: the pair has to cancel out for the parties and the rate the
 * original named, even if the customer has moved, the strategy has changed
 * and the rate has risen since.
 *
 * Amounts are positive — UNTDID 1001 type 381. The document's heading says
 * what it does; the figures do not also have to carry a minus.
 */
export async function createCreditNote(
    db: Db,
    input: CreditNoteInput,
    actor: Actor,
    options: { now?: Date; settings?: Settings } = {},
) {
    const at = options.now ?? new Date();
    const settings = options.settings ?? (await loadSettings());

    return db.transaction(async (tx) =>
        createCreditNoteIn(tx, input, actor, { at, settings }),
    );
}

/**
 * The same correction inside a transaction the caller already owns.
 *
 * Phase 6 needs it: withdrawing a Mahngebühr and rolling a renewal back are
 * both "credit this document **and** put the subscription back", and the two
 * halves have to commit together or the books and the Abo disagree. Same
 * shape, and for the same reason, as `finalizeInvoiceIn`.
 */
export async function createCreditNoteIn(
    tx: Tx,
    input: CreditNoteInput,
    actor: Actor,
    context: { at: Date; settings: Settings },
) {
    const { at, settings } = context;

    {
        const invoice = await lockInvoice(tx, input.invoiceId);

        if (!invoice.number || invoice.status === "draft") {
            throw new InvoiceError(
                "not-finalized",
                "Nur ausgestellte Rechnungen können korrigiert werden.",
            );
        }

        const items = await tx
            .select()
            .from(schema.invoiceItem)
            .where(eq(schema.invoiceItem.invoiceId, invoice.id))
            .orderBy(asc(schema.invoiceItem.position));

        const alreadyCredited = await creditedQuantities(tx, invoice.id);

        const wanted =
            input.kind === "full"
                ? items.map((item) => ({
                      invoiceItemId: item.id,
                      quantity: subtract(
                          item.quantity,
                          alreadyCredited.get(item.id) ?? 0,
                      ),
                  }))
                : (input.lines ?? []);

        const byId = new Map(items.map((item) => [item.id, item]));

        /**
         * What is still open per position, decremented as this call's own
         * lines consume it. Reading `alreadyCredited` afresh for each line
         * would let two entries naming the same position each see the whole
         * remainder, and a correction could then take back more of a line
         * than the invoice ever charged for it.
         */
        const remainingFor = new Map(
            items.map((item) => [
                item.id,
                subtract(item.quantity, alreadyCredited.get(item.id) ?? 0),
            ]),
        );

        const chosen: {
            item: (typeof items)[number];
            quantity: number;
        }[] = [];

        for (const line of wanted) {
            const item = byId.get(line.invoiceItemId);

            if (!item) {
                throw new InvoiceError(
                    "not-creditable",
                    "Eine der Positionen gehört nicht zu dieser Rechnung.",
                );
            }

            if (!Number.isSafeInteger(line.quantity)) {
                throw new InvoiceError(
                    "over-credit",
                    "Die Menge einer Korrekturposition muss eine ganze Zahl sein.",
                );
            }

            if (line.quantity === 0) {
                continue;
            }

            const remaining = remainingFor.get(item.id) ?? 0;

            if (remaining === 0) {
                throw new InvoiceError(
                    "over-credit",
                    `Position ${item.position} ist bereits vollständig korrigiert.`,
                );
            }

            /**
             * A deduction is reversed as a deduction. `POST /api/v1/invoices`
             * accepts — and documents — a negative quantity for a discount
             * line, and a full correction of such an invoice reverses that
             * line with its own sign; forcing it positive would make the
             * correction charge for what the invoice deducted. Refusing it
             * outright, as this used to, left the invoice uncancellable for
             * good: a finalized row can be neither edited nor deleted.
             */
            if (
                Math.sign(line.quantity) !== Math.sign(remaining) ||
                Math.abs(line.quantity) > Math.abs(remaining)
            ) {
                throw new InvoiceError(
                    "over-credit",
                    `Position ${item.position} kann höchstens ${remaining} × korrigiert werden.`,
                );
            }

            remainingFor.set(item.id, subtract(remaining, line.quantity));
            chosen.push({ item, quantity: line.quantity });
        }

        if (chosen.length === 0) {
            throw new InvoiceError(
                "not-creditable",
                "Diese Rechnung ist bereits vollständig korrigiert.",
            );
        }

        const lines: TaxedLineInput[] = chosen.map(({ item, quantity }) => ({
            description: item.description,
            detail: item.detail,
            quantity,
            unitCode: item.unitCode,
            unitPriceCents: item.unitPriceCents,
            // Verbatim from the invoice. An invoice finalized before the tax
            // snapshot existed is credited as what it was: § 19, 0 %, E.
            taxRateBp: item.taxRateBp ?? 0,
            taxCategory: (item.taxCategory as "E") ?? "E",
            taxRule: item.taxRule ?? "kleinunternehmer",
            servicePeriodStart: item.servicePeriodStart,
            servicePeriodEnd: item.servicePeriodEnd,
        }));

        const totals = calculateTotals(lines);
        const credited = add(invoice.creditedCents, totals.grossCents);
        const invoiceGross = invoice.grossCents ?? 0;

        if (invoiceGross > 0 && credited > invoiceGross) {
            throw new InvoiceError(
                "over-credit",
                "Eine Korrektur kann nicht mehr zurücknehmen, als berechnet wurde.",
            );
        }

        const id = createId("creditnote");
        const number = await nextNumber(tx, "creditNote", at);

        await tx.insert(schema.creditNote).values({
            id,
            invoiceId: invoice.id,
            customerId: invoice.customerId,
            number,
            kind: input.kind,
            reason: input.reason?.trim() || null,
            currency: invoice.currency,
            // The correction speaks about the original, so it carries the
            // original's frozen parties — not whoever the account is today.
            recipient: invoice.recipient,
            buyerReference: invoice.buyerReference,
            buyerName: invoice.buyerName,
            buyerStreet: invoice.buyerStreet,
            buyerPostalCode: invoice.buyerPostalCode,
            buyerCity: invoice.buyerCity,
            buyerCountry: invoice.buyerCountry,
            buyerVatId: invoice.buyerVatId,
            buyerEmail: invoice.buyerEmail,
            buyerCustomerNumber: invoice.buyerCustomerNumber,
            sellerName: invoice.sellerName ?? settings.operator.name,
            sellerStreet: invoice.sellerStreet ?? settings.operator.street,
            sellerCity: invoice.sellerCity ?? settings.operator.city,
            sellerCountry: invoice.sellerCountry ?? settings.operator.country,
            sellerEmail: invoice.sellerEmail ?? settings.operator.email,
            sellerPhone: invoice.sellerPhone ?? settings.operator.phone,
            sellerVatId: invoice.sellerVatId ?? settings.operator.vatId,
            sellerTaxNumber:
                invoice.sellerTaxNumber ?? settings.operator.taxNumber,
            sellerBankName: invoice.sellerBankName ?? settings.bank.name,
            sellerIban: invoice.sellerIban ?? settings.bank.iban,
            sellerBic: invoice.sellerBic ?? settings.bank.bic,
            taxStrategy: invoice.taxStrategy ?? "kleinunternehmer",
            taxNote: invoice.taxNote,
            netCents: totals.netCents,
            taxCents: totals.taxCents,
            grossCents: totals.grossCents,
            issuedAt: at,
            servicePeriodStart: invoice.servicePeriodStart,
            servicePeriodEnd: invoice.servicePeriodEnd,
            note: `Korrektur zu Rechnung ${invoice.number}.`,
        });

        await tx.insert(schema.creditNoteItem).values(
            chosen.map(({ item, quantity }, index) => ({
                id: createId("creditnoteitem"),
                creditNoteId: id,
                invoiceItemId: item.id,
                position: index + 1,
                description: item.description,
                detail: item.detail,
                quantity,
                unitCode: item.unitCode,
                unitPriceCents: item.unitPriceCents,
                servicePeriodStart: item.servicePeriodStart,
                servicePeriodEnd: item.servicePeriodEnd,
                taxStrategy: item.taxStrategy ?? "kleinunternehmer",
                taxRateBp: item.taxRateBp ?? 0,
                taxCategory: item.taxCategory ?? "E",
                taxRule: item.taxRule ?? "kleinunternehmer",
                netCents: totals.lines[index].netCents,
            })),
        );

        // A fully credited invoice is annulled; a partly credited one still
        // stands for the rest and keeps the status it had.
        const fullyCredited = invoiceGross > 0 && credited >= invoiceGross;

        await tx
            .update(schema.invoice)
            .set({
                creditedCents: credited,
                ...(fullyCredited
                    ? { status: "cancelled" as const, cancelledAt: at }
                    : {}),
                updatedAt: at,
            })
            .where(eq(schema.invoice.id, invoice.id));

        /**
         * A correction changes what the invoice still asks for, so what has
         * been received against it now means something else: an invoice over
         * 100,00 €, paid in full, with a 30,00 € line corrected away is no
         * longer "100,00 € of 100,00 € paid" but 70,00 € of 70,00 €.
         *
         * Without this the document kept `paid_cents` at 100,00 €, which
         * makes the schema's own invariant false — `paid_cents` is never more
         * than the lines say — and printed "Offen −30,00 €" to the customer.
         * The settlement is the one place that decides those two figures, so
         * it decides them here too. `causedBy` is deliberately not passed: no
         * payment row moved, and attributing the overshoot is a separate
         * decision the operator makes (see `adjustCustomerCredit`).
         */
        await resettleInvoice(tx, invoice.id, at);

        await audit(tx, {
            actor,
            action: "credit_note.create",
            entityType: "credit_note",
            entityId: id,
            after: {
                number,
                invoiceId: invoice.id,
                invoiceNumber: invoice.number,
                kind: input.kind,
                netCents: totals.netCents,
                taxCents: totals.taxCents,
                grossCents: totals.grossCents,
                invoiceStatus: fullyCredited ? "cancelled" : invoice.status,
            },
        });

        return { id, number, totals, fullyCredited };
    }
}

/**
 * Declares a finalized invoice settled, without a payment behind it.
 *
 * **This is not how money is recorded.** Every euro that actually arrives —
 * from a gateway, from a transfer somebody books, from the customer's balance
 * — goes through `applyPayment` in `src/server/payments/apply.ts`, which is
 * the one place an invoice is ever settled and the one place that writes a
 * transaction row.
 *
 * What is left here is the books-only statement "nothing is owed on this any
 * more", which the admin area no longer offers (its button books a transfer
 * instead) and which the revenue tests use to produce paid invoices without
 * a payment apparatus. `paid_cents` is kept in step so the invoice does not
 * read as settled while claiming nothing was received.
 */
export async function markInvoicePaid(
    db: Db,
    invoiceId: string,
    actor: Actor,
    at = new Date(),
) {
    return db.transaction(async (tx) => {
        const row = await lockInvoice(tx, invoiceId);

        if (row.status !== "unpaid" && row.status !== "partial") {
            throw new InvoiceError(
                "not-unpaid",
                "Nur offene Rechnungen können als bezahlt markiert werden.",
            );
        }

        const due = Math.max(
            subtract(row.grossCents ?? 0, row.creditedCents),
            0,
        );

        await tx
            .update(schema.invoice)
            .set({
                status: "paid",
                paidAt: at,
                paidCents: due,
                updatedAt: at,
            })
            .where(eq(schema.invoice.id, invoiceId));

        await audit(tx, {
            actor,
            action: "invoice.pay",
            entityType: "invoice",
            entityId: invoiceId,
            before: { status: "unpaid" },
            after: { status: "paid", paidAt: at.toISOString() },
        });

        return row;
    });
}

/** The counterpart for a payment booked by mistake or later reversed. */
export async function unmarkInvoicePaid(
    db: Db,
    invoiceId: string,
    actor: Actor,
) {
    return db.transaction(async (tx) => {
        const row = await lockInvoice(tx, invoiceId);

        if (row.status !== "paid") {
            throw new InvoiceError(
                "not-paid",
                "Nur bezahlte Rechnungen können zurückgesetzt werden.",
            );
        }

        await tx
            .update(schema.invoice)
            .set({
                status: "unpaid",
                paidAt: null,
                paidCents: 0,
                updatedAt: new Date(),
            })
            .where(eq(schema.invoice.id, invoiceId));

        await audit(tx, {
            actor,
            action: "invoice.unpay",
            entityType: "invoice",
            entityId: invoiceId,
            before: { status: "paid" },
            after: { status: "unpaid" },
        });

        return row;
    });
}

/**
 * Records that the document has been mailed. `sent_at` is one of the few
 * columns the immutability trigger still lets through, because when a copy
 * went out is a fact about the invoice, not a statement on it.
 */
export async function markDocumentSent(
    executor: Executor,
    kind: "invoice" | "creditNote",
    id: string,
    at = new Date(),
) {
    const table = kind === "invoice" ? schema.invoice : schema.creditNote;

    await executor
        .update(table)
        .set({ sentAt: at })
        .where(and(eq(table.id, id)));
}
