import "server-only";
import { renderDocumentPdf } from "@/lib/documents/pdf";
import {
    formatRecipient,
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
import { operator, site } from "@/lib/site";

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
        subject: offer.title,
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

    const pdf = await renderDocumentPdf({
        kind: "invoice",
        number,
        subject: "Ihre Rechnung",
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
                `Alle Rechnungen finden Sie in Ihrem Kundenbereich: ${site.url}/account/invoices`,
            ].join("\n"),
            html: renderEmail({
                preheader: `Rechnung ${number} über ${formatPrice(totals.grossCents)}.`,
                heading: `Rechnung ${number}`,
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    "im Anhang finden Sie Ihre aktuelle Rechnung. Sie liegt als PDF und zusätzlich als XRechnung im XML-Format bei.",
                ],
                action: {
                    label: "Rechnungen ansehen",
                    url: `${site.url}/account/invoices`,
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
