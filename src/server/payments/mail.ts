import "server-only";
import { formatPrice } from "@/lib/format";
import {
    createTransport,
    logMailError,
    mailFrom,
    renderEmail,
} from "@/server/mail";
import { loadSettings } from "@/server/settings";

/**
 * The one mail this phase owes the *customer* rather than the operator.
 *
 * An off-session collection that comes back `requires_action` means the card
 * issuer wants the cardholder to confirm, and there is nobody standing in
 * front of the terminal. Without this the invoice simply goes unpaid and the
 * customer never learns why — so they get a link to a page where they can
 * authenticate, and the invoice stays open until they do.
 */
export async function sendPaymentActionRequiredMail(input: {
    to: string;
    invoiceNumber: string;
    amountCents: number;
    url: string;
}): Promise<void> {
    const { operator, site } = await loadSettings();
    const transport = createTransport();

    if (!transport) {
        console.error(
            "[payments] a payment needs the customer's confirmation and no mail transport is configured:",
            input.invoiceNumber,
        );

        return;
    }

    try {
        await transport.sendMail({
            from: await mailFrom(),
            to: input.to,
            subject: `Bestätigung erforderlich — Rechnung ${input.invoiceNumber}`,
            text: [
                "Sehr geehrte Damen und Herren,",
                "",
                `der Einzug von ${formatPrice(input.amountCents)} zu Rechnung ${input.invoiceNumber} konnte nicht abgeschlossen werden: Ihre Bank verlangt dafür eine Bestätigung durch Sie.`,
                "",
                "Über den folgenden Link können Sie die Zahlung abschließen:",
                input.url,
                "",
                "Bis dahin bleibt die Rechnung offen. Es wird nichts doppelt abgebucht.",
                "",
                "Mit freundlichen Grüßen",
                operator.name,
            ].join("\n"),
            html: await renderEmail({
                preheader: `Rechnung ${input.invoiceNumber}: Ihre Bank verlangt eine Bestätigung.`,
                heading: "Bestätigung erforderlich",
                intro: [
                    "Sehr geehrte Damen und Herren,",
                    `der Einzug von ${formatPrice(input.amountCents)} zu Rechnung ${input.invoiceNumber} konnte nicht abgeschlossen werden: Ihre Bank verlangt dafür eine Bestätigung durch Sie. Bis dahin bleibt die Rechnung offen, und es wird nichts doppelt abgebucht.`,
                ],
                action: { label: "Zahlung abschließen", url: input.url },
                rowsTitle: "Eckdaten",
                rows: [
                    { label: "Rechnung", value: input.invoiceNumber },
                    {
                        label: "Betrag",
                        value: formatPrice(input.amountCents),
                    },
                ],
                outro: [
                    `Ihre Rechnungen finden Sie jederzeit unter ${site.url}/client/invoices.`,
                    `Mit freundlichen Grüßen\n${operator.name}`,
                ],
            }),
        });
    } catch (error) {
        logMailError("payment action required mail", error);
    }
}
