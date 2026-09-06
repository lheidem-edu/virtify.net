import "server-only";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import {
    formatRecipient,
    loadContract,
    loadInvoice,
    loadOffer,
} from "@/lib/documents/repository";
import { renderXRechnung } from "@/lib/documents/xrechnung";
import { formatDate, formatPrice } from "@/lib/format";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/lib/mail";
import { operator, policy, site } from "@/lib/site";

function transportOrThrow() {
    const transport = createTransport();

    if (!transport) {
        throw new Error("VIRTIFY_SMTP_HOST is not set; cannot send document");
    }

    return transport;
}

export async function sendOfferMail(
    offerId: string,
    to: string,
    _name: string,
) {
    // Loaded as admin: the recipient is the owner, and the caller has already
    // established that this send is authorised.
    const loaded = await loadOffer(offerId, "", true);

    if (!loaded) {
        throw new Error("offer not found");
    }

    const { offer, buyer, totals } = loaded;

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
        details: loaded.items.map((item) => item.detail),
    });

    const transport = transportOrThrow();

    try {
        await transport.sendMail({
            from: mailFrom,
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
                `Annehmen oder ablehnen können Sie es in Ihrem Kundenbereich: ${site.url}/account/offers`,
                "",
                "Für Rückfragen stehen wir Ihnen selbstverständlich gerne zur Verfügung und danken Ihnen für die angenehme Zusammenarbeit.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ]
                .filter(Boolean)
                .join("\n"),
            html: renderEmail({
                preheader: `Angebot ${offer.number} über ${formatPrice(totals.grossCents)}.`,
                heading: `Angebot ${offer.number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `im Anhang finden Sie unser Angebot über ${formatPrice(totals.grossCents)}.`,
                ],
                action: {
                    label: "Angebot ansehen",
                    url: `${site.url}/account/offers`,
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
        });
    } catch (error) {
        logMailError("offer mail", error);
        throw error;
    }
}

export async function sendInvoiceMail(
    invoiceId: string,
    to: string,
    _name: string,
) {
    const loaded = await loadInvoice(invoiceId, "", true);

    if (!loaded?.invoice.number) {
        throw new Error("invoice not found or not issued");
    }

    const { invoice, buyer, totals } = loaded;
    // Narrowed by the guard above; the destructure loses that.
    const number = invoice.number as string;

    // A Storno is an invoice like any other — same series, same route — so it
    // is recognised by what it points at rather than by a separate send path.
    const original = invoice.cancelsInvoiceId
        ? ((await loadInvoice(invoice.cancelsInvoiceId, "", true))?.invoice ??
          null)
        : null;
    const label = original ? "Stornorechnung" : "Rechnung";
    const reference = original
        ? `Storno zu Rechnung ${original.number} vom ${formatDate(original.issuedAt)}`
        : null;

    const pdf = await renderDocumentPdf({
        kind: "invoice",
        variant: original ? "storno" : null,
        title: reference,
        number,
        customerNumber: buyer.customerNumber,
        recipient: invoice.recipient ?? formatRecipient(buyer),
        issuedAt: invoice.issuedAt ?? new Date(),
        dueAt: invoice.dueAt,
        servicePeriod: {
            start: invoice.servicePeriodStart,
            end: invoice.servicePeriodEnd,
        },
        introText: invoice.introText,
        note: invoice.note,
        totals,
        details: loaded.items.map((item) => item.detail),
    });

    const xml = renderXRechnung({
        number,
        typeCode: original ? "384" : "380",
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
        buyer: {
            name: buyer.company || buyer.name,
            street: buyer.street,
            postalCode: buyer.postalCode,
            city: buyer.city,
            country: buyer.country,
            vatId: buyer.vatId,
            email: buyer.email,
        },
        totals,
    });

    const transport = transportOrThrow();

    try {
        await transport.sendMail({
            from: mailFrom,
            to,
            subject: `${label} ${number} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                original
                    ? `im Anhang finden Sie die Stornorechnung zu Rechnung ${original.number}. Die ursprüngliche Rechnung ist damit vollständig aufgehoben; eine Zahlung ist hierauf nicht zu leisten.`
                    : "im Anhang finden Sie Ihre aktuelle Rechnung. Sie liegt als PDF und zusätzlich als XRechnung im XML-Format bei.",
                "",
                "Für Rückfragen stehen wir Ihnen selbstverständlich gerne zur Verfügung und danken Ihnen für die angenehme Zusammenarbeit.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
                "",
                `Alle Rechnungen finden Sie in Ihrem Kundenbereich: ${site.url}/account/invoices`,
            ].join("\n"),
            html: renderEmail({
                preheader: `${label} ${number} über ${formatPrice(totals.grossCents)}.`,
                heading: `${label} ${number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    original
                        ? `im Anhang finden Sie die Stornorechnung zu Rechnung ${original.number}. Die ursprüngliche Rechnung ist damit vollständig aufgehoben; eine Zahlung ist hierauf nicht zu leisten.`
                        : "im Anhang finden Sie Ihre aktuelle Rechnung. Sie liegt als PDF und zusätzlich als XRechnung im XML-Format bei.",
                ],
                action: {
                    label: "Rechnungen ansehen",
                    url: `${site.url}/account/invoices`,
                },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: `${label}snummer`, value: number },
                    ...(original
                        ? [
                              {
                                  label: "Storniert",
                                  value: original.number ?? "—",
                              },
                          ]
                        : []),
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
                    content: Buffer.from(pdf),
                    contentType: "application/pdf",
                },
                {
                    filename: `${number}.xml`,
                    content: xml,
                    contentType: "application/xml",
                },
            ],
        });
    } catch (error) {
        logMailError("invoice mail", error);
        throw error;
    }
}

/**
 * Textform notice that a sent offer no longer stands. § 8 (4) of the terms
 * puts every declaration about a contract in Textform, and an offer the
 * customer can still see in the portal needs the same courtesy.
 */
export async function sendOfferWithdrawnMail(offerId: string, to: string) {
    const loaded = await loadOffer(offerId, "", true);

    if (!loaded) {
        throw new Error("offer not found");
    }

    const { offer } = loaded;
    const transport = transportOrThrow();

    try {
        await transport.sendMail({
            from: mailFrom,
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
            html: renderEmail({
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
        });
    } catch (error) {
        logMailError("offer withdrawn mail", error);
        throw error;
    }
}

/**
 * Confirms an acceptance the customer declared outside the portal. § 3 of the
 * terms makes acceptance the Vertragsschluss, so when it is recorded on the
 * customer's behalf they must receive the record of it in Textform — for a
 * consumer this is also what starts the § 355 BGB withdrawal period running
 * against something they can point at.
 */
export async function sendOfferAcceptedMail(offerId: string, to: string) {
    const loaded = await loadOffer(offerId, "", true);

    if (!loaded) {
        throw new Error("offer not found");
    }

    const { offer, totals } = loaded;
    const transport = transportOrThrow();

    try {
        await transport.sendMail({
            from: mailFrom,
            to,
            subject: `Auftragsbestätigung zu Angebot ${offer.number} — ${site.name}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `wie mit Ihnen besprochen haben wir Ihr Angebot ${offer.number} über ${offer.title} für Sie angenommen. Der Vertrag ist damit zustande gekommen.`,
                "",
                `Ihren Vertrag finden Sie in Ihrem Kundenbereich: ${site.url}/account/contracts`,
                "",
                "Sollte die Annahme nicht Ihrem Wunsch entsprechen, teilen Sie uns das bitte umgehend mit.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ].join("\n"),
            html: renderEmail({
                preheader: `Angebot ${offer.number} angenommen — der Vertrag ist zustande gekommen.`,
                heading: `Auftragsbestätigung ${offer.number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `wie mit Ihnen besprochen haben wir Ihr Angebot ${offer.number} über ${offer.title} für Sie angenommen. Der Vertrag ist damit zustande gekommen.`,
                ],
                action: {
                    label: "Vertrag ansehen",
                    url: `${site.url}/account/contracts`,
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
        });
    } catch (error) {
        logMailError("offer accepted mail", error);
        throw error;
    }
}

/**
 * The Kündigungsbestätigung § 8 (4) of the terms owes the customer
 * "unverzüglich in Textform", naming the date the contract actually ends.
 */
export async function sendContractTerminationMail(
    contractId: string,
    to: string,
) {
    const loaded = await loadContract(contractId, "", true);

    if (!loaded) {
        throw new Error("contract not found");
    }

    const { contract } = loaded;
    const endsOn = formatDate(contract.terminatedTo);
    const transport = transportOrThrow();

    try {
        await transport.sendMail({
            from: mailFrom,
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
            html: renderEmail({
                preheader: `Kündigung bestätigt — der Vertrag endet am ${endsOn}.`,
                heading: "Kündigungsbestätigung",
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `hiermit bestätigen wir die Kündigung des Vertrags „${contract.title}“ zum ${endsOn}.`,
                ],
                action: {
                    label: "Vertrag ansehen",
                    url: `${site.url}/account/contracts`,
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
        });
    } catch (error) {
        logMailError("contract termination mail", error);
        throw error;
    }
}
