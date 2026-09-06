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
import { site } from "@/lib/site";

function transportOrThrow() {
    const transport = createTransport();

    if (!transport) {
        throw new Error("VIRTIFY_SMTP_HOST is not set; cannot send document");
    }

    return transport;
}

export async function sendOfferMail(offerId: string, to: string, name: string) {
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
        recipient: offer.recipient ?? formatRecipient(buyer),
        issuedAt: offer.sentAt ?? new Date(),
        validUntil: offer.validUntil,
        introText: offer.introText,
        note: offer.note,
        totals,
    });

    const transport = transportOrThrow();

    try {
        await transport.sendMail({
            from: mailFrom,
            to,
            subject: `Angebot ${offer.number} — ${site.name}`,
            text: [
                `Hallo ${name},`,
                "",
                `anbei unser Angebot ${offer.number} über ${formatPrice(totals.grossCents)}.`,
                offer.validUntil
                    ? `Es ist gültig bis ${formatDate(offer.validUntil)}.`
                    : "",
                "",
                `Annehmen oder ablehnen kannst du es in deinem Konto: ${site.url}/account/offers`,
            ]
                .filter(Boolean)
                .join("\n"),
            html: renderEmail({
                preheader: `Angebot ${offer.number} über ${formatPrice(totals.grossCents)}.`,
                heading: `Angebot ${offer.number}`,
                intro: [
                    `Hallo ${name},`,
                    `anbei unser Angebot über ${formatPrice(totals.grossCents)}. Das PDF hängt dieser Nachricht an.`,
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
    name: string,
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
        title: "Rechnung",
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
    });

    const xml = renderXRechnung({
        number,
        issuedAt: invoice.issuedAt ?? new Date(),
        dueAt: invoice.dueAt,
        buyerReference:
            invoice.buyerReference ?? buyer.buyerReference ?? buyer.id,
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
                `Hallo ${name},`,
                "",
                `anbei die Rechnung ${number} über ${formatPrice(totals.grossCents)}.`,
                invoice.dueAt
                    ? `Sie ist zahlbar bis ${formatDate(invoice.dueAt)}.`
                    : "",
                "",
                "Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet.",
                "",
                `Alle Rechnungen findest du in deinem Konto: ${site.url}/account/invoices`,
            ]
                .filter(Boolean)
                .join("\n"),
            html: renderEmail({
                preheader: `Rechnung ${number} über ${formatPrice(totals.grossCents)}.`,
                heading: `Rechnung ${number}`,
                intro: [
                    `Hallo ${name},`,
                    "anbei die Rechnung als PDF und zusätzlich als XRechnung im XML-Format.",
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
                    "Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet.",
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
