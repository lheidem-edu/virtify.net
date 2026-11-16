import "server-only";
import { db } from "@/db";
import { formatDate, formatPrice } from "@/lib/format";
import {
    creditNotePdf,
    invoicePdf,
    sellerOf,
} from "@/server/billing/invoices/pdf";
import {
    loadCreditNote,
    loadInvoice,
} from "@/server/billing/invoices/repository";
import { renderDocumentPdf, sellerFromSettings } from "@/server/documents/pdf";
import {
    formatRecipient,
    loadBuyer,
    loadContract,
    loadOffer,
    xmlBuyer,
} from "@/server/documents/repository";
import { renderXRechnung } from "@/server/documents/xrechnung";
import {
    addressList,
    logMailError,
    type MailMessage,
    mailFrom,
    mailTransport,
    renderEmail,
} from "@/server/mail";
import { recordMail } from "@/server/mail/outbox";
import type { DirectMailId } from "@/server/mail/templates/direct";
import { loadSettings } from "@/server/settings";

async function transportOrThrow() {
    const transport = await mailTransport();

    if (!transport) {
        throw new Error("VIRTIFY_SMTP_HOST is not set; cannot send document");
    }

    return transport;
}

/**
 * Sends a document mail and writes it into `email_log`.
 *
 * These are the `direct` half of the catalogue
 * (`src/server/mail/templates/direct.ts`): an operator presses „senden", the
 * document is rendered in that request, and the failure has to come back to
 * the button rather than to a queue. The outbox can *fetch* a stored PDF but
 * never render one — deliberately, because that is what lets the worker send
 * mail at all — so a mail that carries a freshly rendered XRechnung belongs
 * in a web process.
 *
 * They are still recorded, under the same unique key as a queued mail, so
 * there is one table that answers "what has this customer ever been sent".
 * The record is best-effort: a recording that fails must not make a send that
 * worked look like a failure, which is the same direction Phase 7's reply
 * takes and for the same reason — the one thing that must not happen next is
 * the operator pressing send again.
 */
async function deliver(input: {
    template: DirectMailId;
    dedupeKey: string;
    customerId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    context: string;
    message: MailMessage;
}): Promise<void> {
    const transport = await transportOrThrow();
    const to = addressList(input.message.to)[0] ?? "";

    const record = async (
        outcome: Parameters<typeof recordMail>[1]["outcome"],
    ) => {
        try {
            await recordMail(db, {
                template: input.template,
                dedupeKey: input.dedupeKey,
                toEmail: to,
                customerId: input.customerId ?? null,
                entityType: input.entityType ?? null,
                entityId: input.entityId ?? null,
                subject: input.message.subject,
                bodyText: input.message.text ?? null,
                outcome,
            });
        } catch (error) {
            console.error(`[mail] could not record ${input.context}:`, error);
        }
    };

    try {
        const sent = await transport.sendMail(input.message);

        await record({
            sent: true,
            messageId: sent.messageId,
            transport: transport.id,
        });
    } catch (error) {
        logMailError(input.context, error);

        await record({
            sent: false,
            error: error instanceof Error ? error.message : String(error),
        });

        throw error;
    }
}

export async function sendOfferMail(
    offerId: string,
    to: string,
    _name: string,
) {
    const { operator, site } = await loadSettings();
    // Loaded as admin: the recipient is the owner, and the caller has already
    // established that this send is authorised.
    const loaded = await loadOffer(offerId, "", true);

    if (!loaded) {
        throw new Error("offer not found");
    }

    const { offer, buyer, totals, taxNotes } = loaded;

    const pdf = await renderDocumentPdf({
        kind: "offer",
        number: offer.number,
        title: offer.title,
        customerNumber: buyer.customerNumber,
        recipient: offer.recipient ?? formatRecipient(buyer),
        issuedAt: offer.sentAt ?? new Date(),
        validUntil: offer.validUntil,
        introText: offer.introText,
        note: offer.note,
        totals,
        seller: sellerFromSettings(await loadSettings()),
        // An offer is not a § 14 document, so it shows the tax it would be
        // charged under today's strategy — including none at all.
        showTax:
            totals.taxCents !== 0 || totals.groups.some((g) => g.rateBp > 0),
        taxNotes,
    });

    await deliver({
        template: "offer.document",
        dedupeKey: `offer:${offer.id}:${offer.sentAt?.toISOString() ?? "draft"}`,
        customerId: buyer.id,
        entityType: "offer",
        entityId: offer.id,
        context: "offer mail",
        message: {
            from: await mailFrom(),
            to,
            subject: `Angebot ${offer.number} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `im Anhang finden Sie unser Angebot ${offer.number} über ${formatPrice(totals.grossCents)}.`,
                offer.validUntil
                    ? `Es ist gültig bis ${formatDate(offer.validUntil)}.`
                    : "",
                "",
                `Annehmen oder ablehnen können Sie es in Ihrem Kundenbereich: ${site.url}/client/offers`,
                "",
                "Für Rückfragen stehen wir Ihnen selbstverständlich gerne zur Verfügung und danken Ihnen für die angenehme Zusammenarbeit.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ]
                .filter(Boolean)
                .join("\n"),
            html: await renderEmail({
                preheader: `Angebot ${offer.number} über ${formatPrice(totals.grossCents)}.`,
                heading: `Angebot ${offer.number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `im Anhang finden Sie unser Angebot über ${formatPrice(totals.grossCents)}.`,
                ],
                action: {
                    label: "Angebot ansehen",
                    url: `${site.url}/client/offers`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Angebotsnummer", value: offer.number },
                    { label: "Betrag", value: formatPrice(totals.grossCents) },
                    ...(offer.validUntil
                        ? [
                              {
                                  label: "Gültig bis",
                                  value: formatDate(offer.validUntil),
                              },
                          ]
                        : []),
                ],
                outro: [
                    "Mit der Annahme im Kundenbereich kommt der Vertrag zustande.",
                    "Für Rückfragen stehen wir Ihnen selbstverständlich gerne zur Verfügung und danken Ihnen für die angenehme Zusammenarbeit.",
                    `Mit freundlichen Grüßen\n${operator.name}`,
                ],
            }),
            attachments: [
                {
                    filename: `${offer.number}.pdf`,
                    content: Buffer.from(pdf),
                    contentType: "application/pdf",
                },
            ],
        },
    });
}

export async function sendInvoiceMail(
    invoiceId: string,
    to: string,
    _name: string,
) {
    const { site } = await loadSettings();
    const loaded = await loadInvoice(invoiceId, "", true);

    if (!loaded?.invoice.number) {
        throw new Error("invoice not found or not finalized");
    }

    const { invoice, buyer, totals, taxNotes } = loaded;
    // Narrowed by the guard above; the destructure loses that.
    const number = invoice.number as string;

    const result = await invoicePdf(db, invoiceId, {
        customerId: "",
        isAdmin: true,
    });

    if (!result) {
        throw new Error("invoice not found");
    }

    const seller = sellerOf(invoice, await loadSettings());

    const xml = renderXRechnung({
        seller,
        siteName: site.name,
        number,
        typeCode: "380",
        issuedAt: invoice.issuedAt ?? new Date(),
        dueAt: invoice.dueAt,
        buyerReference:
            invoice.buyerReference ??
            buyer.buyerReference ??
            String(buyer.customerNumber ?? buyer.id),
        servicePeriod: {
            start: invoice.servicePeriodStart,
            end: invoice.servicePeriodEnd,
        },
        note: invoice.note,
        taxNotes,
        buyer: xmlBuyer(invoice, buyer),
        totals,
    });

    const { operator } = await loadSettings();

    await deliver({
        template: "invoice.document",
        dedupeKey: `invoice:${invoice.id}:${number}`,
        customerId: invoice.customerId,
        entityType: "invoice",
        entityId: invoice.id,
        context: "invoice mail",
        message: {
            from: await mailFrom(),
            to,
            subject: `Rechnung ${number} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                "im Anhang finden Sie Ihre aktuelle Rechnung. Sie liegt als PDF und zusätzlich als XRechnung im XML-Format bei.",
                "",
                "Für Rückfragen stehen wir Ihnen selbstverständlich gerne zur Verfügung und danken Ihnen für die angenehme Zusammenarbeit.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
                "",
                `Alle Rechnungen finden Sie in Ihrem Kundenbereich: ${site.url}/client/invoices`,
            ].join("\n"),
            html: await renderEmail({
                preheader: `Rechnung ${number} über ${formatPrice(totals.grossCents)}.`,
                heading: `Rechnung ${number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    "im Anhang finden Sie Ihre aktuelle Rechnung. Sie liegt als PDF und zusätzlich als XRechnung im XML-Format bei.",
                ],
                action: {
                    label: "Rechnungen ansehen",
                    url: `${site.url}/client/invoices`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Rechnungsnummer", value: number },
                    { label: "Betrag", value: formatPrice(totals.grossCents) },
                    ...(invoice.dueAt
                        ? [
                              {
                                  label: "Fällig am",
                                  value: formatDate(invoice.dueAt),
                              },
                          ]
                        : []),
                ],
                outro: [
                    "Für Rückfragen stehen wir Ihnen selbstverständlich gerne zur Verfügung und danken Ihnen für die angenehme Zusammenarbeit.",
                    `Mit freundlichen Grüßen\n${operator.name}`,
                ],
            }),
            attachments: [
                {
                    filename: `${number}.pdf`,
                    content: result.bytes,
                    contentType: "application/pdf",
                },
                {
                    filename: `${number}.xml`,
                    content: xml,
                    contentType: "application/xml",
                },
            ],
        },
    });
}

/**
 * A Rechnungskorrektur goes out as its own document, with its own number and
 * its own XRechnung (UNTDID 1001 type 381, positive amounts, referencing the
 * invoice it corrects).
 */
export async function sendCreditNoteMail(
    creditNoteId: string,
    to: string,
    _name: string,
) {
    const settings = await loadSettings();
    const { operator, site } = settings;
    const loaded = await loadCreditNote(creditNoteId, "", true);

    if (!loaded) {
        throw new Error("credit note not found");
    }

    const { creditNote, totals, invoice } = loaded;
    const buyer = await loadBuyer(creditNote.customerId, db);

    const result = await creditNotePdf(db, creditNoteId, {
        customerId: "",
        isAdmin: true,
    });

    if (!result) {
        throw new Error("credit note not found");
    }

    const xml = renderXRechnung({
        seller: sellerOf(creditNote, settings),
        siteName: site.name,
        number: creditNote.number,
        typeCode: "381",
        issuedAt: creditNote.issuedAt,
        dueAt: null,
        buyerReference:
            creditNote.buyerReference ??
            buyer.buyerReference ??
            String(buyer.customerNumber ?? buyer.id),
        servicePeriod: {
            start: creditNote.servicePeriodStart,
            end: creditNote.servicePeriodEnd,
        },
        note: creditNote.note,
        taxNotes: creditNote.taxNote ? [creditNote.taxNote] : [],
        precedingNumber: invoice?.number ?? null,
        precedingIssuedAt: invoice?.issuedAt ?? null,
        buyer: xmlBuyer(creditNote, buyer),
        totals,
    });

    await deliver({
        template: "creditnote.document",
        dedupeKey: `creditnote:${creditNote.id}`,
        customerId: creditNote.customerId,
        entityType: "credit_note",
        entityId: creditNote.id,
        context: "credit note mail",
        message: {
            from: await mailFrom(),
            to,
            subject: `Rechnungskorrektur ${creditNote.number} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `im Anhang finden Sie die Rechnungskorrektur zu Rechnung ${invoice?.number ?? ""}. Die korrigierten Positionen sind darin aufgeführt; eine Zahlung ist hierauf nicht zu leisten.`,
                "",
                "Mit freundlichen Grüßen",
                operator.name,
                "",
                `Alle Belege finden Sie in Ihrem Kundenbereich: ${site.url}/client/invoices`,
            ].join("\n"),
            html: await renderEmail({
                preheader: `Rechnungskorrektur ${creditNote.number} über ${formatPrice(totals.grossCents)}.`,
                heading: `Rechnungskorrektur ${creditNote.number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `im Anhang finden Sie die Rechnungskorrektur zu Rechnung ${invoice?.number ?? ""}. Eine Zahlung ist hierauf nicht zu leisten.`,
                ],
                action: {
                    label: "Belege ansehen",
                    url: `${site.url}/client/invoices`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Korrekturnummer", value: creditNote.number },
                    { label: "Korrigiert", value: invoice?.number ?? "—" },
                    { label: "Betrag", value: formatPrice(totals.grossCents) },
                ],
                outro: [`Mit freundlichen Grüßen\n${operator.name}`],
            }),
            attachments: [
                {
                    filename: `${creditNote.number}.pdf`,
                    content: result.bytes,
                    contentType: "application/pdf",
                },
                {
                    filename: `${creditNote.number}.xml`,
                    content: xml,
                    contentType: "application/xml",
                },
            ],
        },
    });
}

/**
 * Textform notice that a sent offer no longer stands. § 8 (4) of the terms
 * puts every declaration about a contract in Textform, and an offer the
 * customer can still see in the portal needs the same courtesy.
 */
export async function sendOfferWithdrawnMail(offerId: string, to: string) {
    const { operator, site } = await loadSettings();
    const loaded = await loadOffer(offerId, "", true);

    if (!loaded) {
        throw new Error("offer not found");
    }

    const { offer } = loaded;
    await deliver({
        template: "offer.withdrawn",
        dedupeKey: `offer:${offer.id}:withdrawn`,
        customerId: offer.customerId,
        entityType: "offer",
        entityId: offer.id,
        context: "offer withdrawn mail",
        message: {
            from: await mailFrom(),
            to,
            subject: `Angebot ${offer.number} zurückgezogen — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `unser Angebot ${offer.number} über ${offer.title} nehmen wir hiermit zurück. Es kann nicht mehr angenommen werden.`,
                "",
                "Gerne unterbreiten wir Ihnen ein neues Angebot.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ].join("\n"),
            html: await renderEmail({
                preheader: `Angebot ${offer.number} wurde zurückgezogen.`,
                heading: `Angebot ${offer.number} zurückgezogen`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `unser Angebot ${offer.number} über ${offer.title} nehmen wir hiermit zurück. Es kann nicht mehr angenommen werden.`,
                ],
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Angebotsnummer", value: offer.number },
                    { label: "Bezeichnung", value: offer.title },
                ],
                outro: [
                    "Gerne unterbreiten wir Ihnen ein neues Angebot.",
                    `Mit freundlichen Grüßen\n${operator.name}`,
                ],
            }),
        },
    });
}

/**
 * Confirms an acceptance the customer declared outside the portal. § 3 of the
 * terms makes acceptance the Vertragsschluss, so when it is recorded on the
 * customer's behalf they must receive the record of it in Textform — for a
 * consumer this is also what starts the § 355 BGB withdrawal period running
 * against something they can point at.
 */
export async function sendOfferAcceptedMail(offerId: string, to: string) {
    const { operator, site } = await loadSettings();
    const loaded = await loadOffer(offerId, "", true);

    if (!loaded) {
        throw new Error("offer not found");
    }

    const { offer, totals } = loaded;
    await deliver({
        template: "offer.accepted",
        dedupeKey: `offer:${offer.id}:accepted`,
        customerId: offer.customerId,
        entityType: "offer",
        entityId: offer.id,
        context: "offer accepted mail",
        message: {
            from: await mailFrom(),
            to,
            subject: `Auftragsbestätigung zu Angebot ${offer.number} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `wie mit Ihnen besprochen haben wir Ihr Angebot ${offer.number} über ${offer.title} für Sie angenommen. Der Vertrag ist damit zustande gekommen.`,
                "",
                `Ihren Vertrag finden Sie in Ihrem Kundenbereich: ${site.url}/client/contracts`,
                "",
                "Sollte die Annahme nicht Ihrem Wunsch entsprechen, teilen Sie uns das bitte umgehend mit.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ].join("\n"),
            html: await renderEmail({
                preheader: `Angebot ${offer.number} angenommen — der Vertrag ist zustande gekommen.`,
                heading: `Auftragsbestätigung ${offer.number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `wie mit Ihnen besprochen haben wir Ihr Angebot ${offer.number} über ${offer.title} für Sie angenommen. Der Vertrag ist damit zustande gekommen.`,
                ],
                action: {
                    label: "Vertrag ansehen",
                    url: `${site.url}/client/contracts`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Angebotsnummer", value: offer.number },
                    { label: "Bezeichnung", value: offer.title },
                    {
                        label: "Monatlich",
                        value: formatPrice(offer.monthlyPriceCents),
                    },
                    {
                        label: "Grundlaufzeit",
                        value: `${offer.minimumTermMonths} Monate`,
                    },
                    {
                        label: "Einmalig",
                        value: formatPrice(totals.grossCents),
                    },
                ],
                outro: [
                    "Sollte die Annahme nicht Ihrem Wunsch entsprechen, teilen Sie uns das bitte umgehend mit.",
                    `Mit freundlichen Grüßen\n${operator.name}`,
                ],
            }),
        },
    });
}

/**
 * The Kündigungsbestätigung § 8 (4) of the terms owes the customer
 * "unverzüglich in Textform", naming the date the contract actually ends.
 */
export async function sendContractTerminationMail(
    contractId: string,
    to: string,
) {
    const { operator, policy, site } = await loadSettings();
    const loaded = await loadContract(contractId, "", true);

    if (!loaded) {
        throw new Error("contract not found");
    }

    const { contract } = loaded;
    const endsOn = formatDate(contract.terminatedTo);
    await deliver({
        template: "contract.terminated",
        dedupeKey: `contract:${contract.id}:terminated`,
        customerId: contract.customerId,
        entityType: "contract",
        entityId: contract.id,
        context: "contract termination mail",
        message: {
            from: await mailFrom(),
            to,
            subject: `Kündigungsbestätigung ${contract.title} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `hiermit bestätigen wir die Kündigung des Vertrags „${contract.title}“ zum ${endsOn}.`,
                "",
                `Bis dahin bleibt die Leistung unverändert nutzbar. Nach Vertragsende stehen Ihre Daten noch ${policy.dataRetrievalDays} Tage zum Abruf bereit und werden anschließend gelöscht.`,
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ].join("\n"),
            html: await renderEmail({
                preheader: `Kündigung bestätigt — der Vertrag endet am ${endsOn}.`,
                heading: "Kündigungsbestätigung",
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `hiermit bestätigen wir die Kündigung des Vertrags „${contract.title}“ zum ${endsOn}.`,
                ],
                action: {
                    label: "Vertrag ansehen",
                    url: `${site.url}/client/contracts`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Vertrag", value: contract.title },
                    { label: "Vertragsnummer", value: contract.number },
                    { label: "Vertragsende", value: endsOn },
                ],
                outro: [
                    `Bis zum Vertragsende bleibt die Leistung unverändert nutzbar. Danach stehen Ihre Daten noch ${policy.dataRetrievalDays} Tage zum Abruf bereit und werden anschließend gelöscht.`,
                    `Mit freundlichen Grüßen\n${operator.name}`,
                ],
            }),
        },
    });
}

/**
 * The receipt mail used to live here. Phase 9 moved it into the outbox: it is
 * `payment.received`, emitted inside the transaction that books the money and
 * rendered from `src/server/mail/templates`. Nothing sends a receipt from a
 * request any more, which is why a receipt can no longer be lost by a process
 * that died between the commit and the send.
 */

/**
 * The notice § 17 of the terms owes the customer before a new version of a
 * legal document takes effect: what changes, when, and that not objecting
 * within the period counts as agreement. Sent on the operator's word, never
 * automatically — publishing a version and telling people about it are two
 * decisions, and only the second one is irreversible in the customer's inbox.
 */
export async function sendLegalChangeMail(input: {
    to: string;
    documentLabel: string;
    documentPath: string;
    effectiveFrom: Date;
}) {
    const { operator, site } = await loadSettings();
    const effective = formatDate(input.effectiveFrom);

    await deliver({
        template: "legal.change",
        dedupeKey: `legal:${input.documentPath}:${input.effectiveFrom.toISOString()}`,
        customerId: null,
        entityType: "legal_document",
        entityId: input.documentPath,
        context: "legal change notice",
        message: {
            from: await mailFrom(),
            to: input.to,
            subject: `Änderung: ${input.documentLabel} zum ${effective} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `wir haben unsere ${input.documentLabel} überarbeitet. Die neue Fassung gilt ab dem ${effective}.`,
                "",
                `Sie können sie hier einsehen: ${site.url}${input.documentPath}`,
                "",
                "Widersprechen Sie der Änderung nicht innerhalb von sechs Wochen nach Zugang dieser Mitteilung in Textform, gilt sie als angenommen. Widersprechen Sie, kann jede Vertragspartei den Vertrag zum geplanten Zeitpunkt des Wirksamwerdens kündigen.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ].join("\n"),
            html: await renderEmail({
                preheader: `${input.documentLabel} in neuer Fassung ab ${effective}.`,
                heading: `${input.documentLabel} in neuer Fassung`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `wir haben unsere ${input.documentLabel} überarbeitet. Die neue Fassung gilt ab dem ${effective}.`,
                ],
                action: {
                    label: `${input.documentLabel} ansehen`,
                    url: `${site.url}${input.documentPath}`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Dokument", value: input.documentLabel },
                    { label: "Gilt ab", value: effective },
                ],
                outro: [
                    "Widersprechen Sie der Änderung nicht innerhalb von sechs Wochen nach Zugang dieser Mitteilung in Textform, gilt sie als angenommen. Widersprechen Sie, kann jede Vertragspartei den Vertrag zum geplanten Zeitpunkt des Wirksamwerdens kündigen.",
                    `Mit freundlichen Grüßen\n${operator.name}`,
                ],
            }),
        },
    });
}
