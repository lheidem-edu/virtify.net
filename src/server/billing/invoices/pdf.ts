import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { formatDate } from "@/lib/format";
import type { GiroCodeInput } from "@/lib/giro-code";
import {
    type DocumentPdfInput,
    type PdfSeller,
    renderDocumentPdf,
    sellerFromSettings,
} from "@/server/documents/pdf";
import { formatRecipient } from "@/server/documents/repository";
import { loadSettings, type Settings } from "@/server/settings";
import { documentStorage } from "@/server/storage";
import { loadCreditNote, loadInvoice } from "./repository";
import type { DocumentTotals } from "./totals";

/**
 * Rendering a document and keeping the bytes.
 *
 * A finalized invoice is rendered once, right after it is finalized, and the
 * bytes are stored. Every later request is served from the store — not
 * re-rendered — so a change to the template cannot quietly restyle a document
 * the customer already holds, and the stored SHA-256 says whether what came
 * back is what went in.
 *
 * The rendering is still reproducible: everything on the document is frozen
 * on the row, so a document whose bytes are missing — the render failed, the
 * volume was lost — is produced again from the snapshot rather than being
 * gone. That is why storing is write-once rather than write-never-again: the
 * row either has a key or it does not, and only the first writer sets it.
 */

type Db = typeof defaultDb;

type Frozen = {
    sellerName: string | null;
    sellerStreet: string | null;
    sellerCity: string | null;
    sellerCountry: string | null;
    sellerEmail: string | null;
    sellerPhone: string | null;
    sellerVatId: string | null;
    sellerTaxNumber: string | null;
    sellerBankName: string | null;
    sellerIban: string | null;
    sellerBic: string | null;
};

/** The frozen seller, or the current settings while nothing is frozen yet. */
export function sellerOf(row: Frozen, settings: Settings): PdfSeller {
    if (!row.sellerName) {
        return sellerFromSettings(settings);
    }

    return {
        name: row.sellerName,
        street: row.sellerStreet ?? "",
        city: row.sellerCity ?? "",
        country: row.sellerCountry ?? "",
        email: row.sellerEmail ?? "",
        phone: row.sellerPhone ?? "",
        vatId: row.sellerVatId,
        taxNumber: row.sellerTaxNumber,
        bankName: row.sellerBankName ?? "",
        iban: row.sellerIban ?? "",
        bic: row.sellerBic ?? "",
    };
}

/**
 * Whether the document shows a tax column at all.
 *
 * Driven by the strategy the document was frozen under, because that is the
 * one fact that survives: § 19 UStG forbids showing a tax amount, so a
 * Kleinunternehmer invoice has no column, no zero line and no summary. Every
 * other strategy shows the breakdown § 14 Abs. 4 Nr. 8 UStG asks for.
 */
export function showsTax(strategy: string | null): boolean {
    return (strategy ?? "kleinunternehmer") !== "kleinunternehmer";
}

function giroFor(
    seller: PdfSeller,
    amountCents: number,
    reference: string,
): GiroCodeInput | null {
    // Nothing to transfer, nothing to scan — and the EPC specification has no
    // way to express a zero amount.
    if (amountCents <= 0 || !seller.iban) {
        return null;
    }

    return {
        name: seller.name,
        iban: seller.iban,
        bic: seller.bic || null,
        amountCents,
        remittance: reference,
    };
}

export type DocumentBytes = {
    bytes: Buffer;
    filename: string;
    /** True when the bytes came from the store rather than the renderer. */
    stored: boolean;
};

function safeName(value: string) {
    return `${value.replace(/[^\w.-]/g, "-")}.pdf`;
}

/**
 * The invoice as a PDF: from the store where it is kept, rendered and stored
 * where it is not, rendered and *not* stored while it is still a draft.
 */
export async function invoicePdf(
    db: Db,
    id: string,
    viewer: { customerId: string; isAdmin: boolean },
): Promise<DocumentBytes | null> {
    const loaded = await loadInvoice(id, viewer.customerId, viewer.isAdmin, db);

    if (!loaded) {
        return null;
    }

    // A draft is not a document anyone outside the office may see: it has no
    // number, it is still editable, and it would read as a demand for money.
    if (!viewer.isAdmin && loaded.invoice.status === "draft") {
        return null;
    }

    const { invoice, buyer, totals, taxNotes } = loaded;
    const settings = await loadSettings();

    if (invoice.pdfKey) {
        const stored = await documentStorage().get(invoice.pdfKey);

        if (stored) {
            return {
                bytes: stored,
                filename: safeName(invoice.number ?? invoice.id),
                stored: true,
            };
        }

        console.error(
            `[invoices] ${invoice.number}: pdf_key ${invoice.pdfKey} has no object behind it; re-rendering`,
        );
    }

    const seller = sellerOf(invoice, settings);
    const isDraft = invoice.status === "draft";

    const input: DocumentPdfInput = {
        kind: "invoice",
        variant: isDraft ? "draft" : null,
        number: invoice.number ?? "ENTWURF",
        recipient:
            invoice.recipient ??
            formatRecipient(buyer, settings.operator.country),
        customerNumber: invoice.buyerCustomerNumber ?? buyer.customerNumber,
        buyerVatId: invoice.buyerVatId ?? buyer.vatId,
        issuedAt: invoice.issuedAt ?? new Date(),
        dueAt: invoice.dueAt,
        servicePeriod: {
            start: invoice.servicePeriodStart,
            end: invoice.servicePeriodEnd,
        },
        introText: invoice.introText,
        note: invoice.note,
        totals,
        seller,
        showTax: showsTax(loaded.effectiveTaxStrategy),
        taxNotes,
        giro: isDraft
            ? null
            : giroFor(seller, totals.grossCents, invoice.number ?? ""),
    };

    const bytes = Buffer.from(await renderDocumentPdf(input));

    if (!isDraft && invoice.number) {
        await store(
            db,
            "invoice",
            invoice.id,
            invoice.number,
            invoice.issuedAt,
            bytes,
        );
    }

    return {
        bytes,
        filename: safeName(invoice.number ?? invoice.id),
        stored: false,
    };
}

export async function creditNotePdf(
    db: Db,
    id: string,
    viewer: { customerId: string; isAdmin: boolean },
): Promise<DocumentBytes | null> {
    const loaded = await loadCreditNote(
        id,
        viewer.customerId,
        viewer.isAdmin,
        db,
    );

    if (!loaded) {
        return null;
    }

    const { creditNote, totals, invoice } = loaded;
    const settings = await loadSettings();

    if (creditNote.pdfKey) {
        const stored = await documentStorage().get(creditNote.pdfKey);

        if (stored) {
            return {
                bytes: stored,
                filename: safeName(creditNote.number),
                stored: true,
            };
        }

        console.error(
            `[invoices] ${creditNote.number}: pdf_key ${creditNote.pdfKey} has no object behind it; re-rendering`,
        );
    }

    const bytes = Buffer.from(
        await renderDocumentPdf(
            creditNotePdfInput(creditNote, totals, invoice, settings),
        ),
    );

    await store(
        db,
        "creditNote",
        creditNote.id,
        creditNote.number,
        creditNote.issuedAt,
        bytes,
    );

    return { bytes, filename: safeName(creditNote.number), stored: false };
}

export function creditNotePdfInput(
    creditNote: typeof schema.creditNote.$inferSelect,
    totals: DocumentTotals,
    invoice: { number: string | null; issuedAt: Date | null } | null,
    settings: Settings,
): DocumentPdfInput {
    return {
        kind: "creditnote",
        number: creditNote.number,
        title: invoice?.number
            ? `Korrektur zu Rechnung ${invoice.number} vom ${formatDate(invoice.issuedAt)}`
            : null,
        recipient: creditNote.recipient ?? "",
        customerNumber: creditNote.buyerCustomerNumber,
        buyerVatId: creditNote.buyerVatId,
        issuedAt: creditNote.issuedAt,
        servicePeriod: {
            start: creditNote.servicePeriodStart,
            end: creditNote.servicePeriodEnd,
        },
        introText: creditNote.reason,
        note: creditNote.note,
        totals,
        seller: sellerOf(creditNote, settings),
        showTax: showsTax(creditNote.taxStrategy),
        taxNotes: creditNote.taxNote ? [creditNote.taxNote] : [],
        giro: null,
    };
}

/** `invoices/2026/RE-2026-0001.pdf` — year first, so a directory stays small. */
export function storageKey(
    kind: "invoice" | "creditNote",
    number: string,
    at: Date | null,
) {
    const year = at ? at.getUTCFullYear() : new Date().getUTCFullYear();
    const folder = kind === "invoice" ? "invoices" : "credit-notes";

    return `${folder}/${year}/${number.replace(/[^\w.-]/g, "-")}.pdf`;
}

/**
 * Writes the bytes and records where they went — but only for a row that has
 * no key yet. Two requests racing for the PDF of an invoice whose render
 * failed earlier both write the object; exactly one of them wins the row, and
 * the key the loser wrote points at the same bytes for the same frozen input.
 */
async function store(
    db: Db,
    kind: "invoice" | "creditNote",
    id: string,
    number: string,
    at: Date | null,
    bytes: Buffer,
) {
    const table = kind === "invoice" ? schema.invoice : schema.creditNote;
    const key = storageKey(kind, number, at);

    try {
        const object = await documentStorage().put(
            key,
            bytes,
            "application/pdf",
        );

        await db
            .update(table)
            .set({
                pdfKey: object.key,
                pdfSha256: object.sha256,
                pdfBytes: object.bytes,
                pdfRenderedAt: new Date(),
            })
            .where(and(eq(table.id, id), isNull(table.pdfKey)));
    } catch (error) {
        // A document store that is full or unreachable must not stop a
        // customer from downloading their invoice: the bytes are in hand.
        console.error(`[invoices] storing ${key} failed:`, error);
    }
}

/**
 * Renders and stores a freshly finalized document. Called after the
 * transaction has committed, so neither a slow renderer nor a full disk can
 * roll back a number that has already been handed out.
 */
export async function storeFinalizedPdf(
    db: Db,
    kind: "invoice" | "creditNote",
    id: string,
) {
    try {
        const viewer = { customerId: "", isAdmin: true };

        if (kind === "invoice") {
            await invoicePdf(db, id, viewer);
        } else {
            await creditNotePdf(db, id, viewer);
        }
    } catch (error) {
        console.error(`[invoices] rendering ${kind} ${id} failed:`, error);
    }
}
