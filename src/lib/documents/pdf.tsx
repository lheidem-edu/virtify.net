import {
    Document,
    Page,
    renderToBuffer,
    StyleSheet,
    Text,
    View,
} from "@react-pdf/renderer";
import type { Totals } from "@/lib/documents/totals";
import {
    documentFont,
    FAINT,
    HAIRLINE,
    INK,
    MUTED,
    mm,
    RULE,
} from "@/lib/documents/typography";
import {
    formatDate,
    formatDateRange,
    formatPrice,
    formatQuantity,
} from "@/lib/format";
import { loadSettings, type Settings } from "@/lib/settings";

/**
 * Business letter per DIN 5008 Form B. The measurements below are the
 * standard's, not taste: the address field sits at 45 mm so it shows through
 * a DIN-lang window envelope, the subject line at 98.46 mm, and the fold and
 * hole marks at 87 / 148.5 / 192 mm so the sheet folds and files correctly.
 *
 * Everything the standard leaves open — type, rules, weight, spacing — follows
 * the website instead: Inter, hairlines, and whitespace doing the work that
 * boxes and bold rules usually do on an invoice.
 */

const MARGIN_LEFT = 24.1;
const MARGIN_RIGHT = 20;
const ADDRESS_TOP = 45;
const ADDRESS_WIDTH = 85;
/** Zusatz- und Vermerkzone: the lines above the address itself. */
const ADDRESS_ZONE_TOP = 17.7;
const INFO_BLOCK_LEFT = 125;
const SUBJECT_TOP = 98.46;

const styles = StyleSheet.create({
    page: {
        fontFamily: documentFont,
        // Lining, equal-width figures: without this Inter's proportional
        // digits make the amount column look ragged from row to row.
        fontFeatureSettings: ["tnum"],
        paddingBottom: mm(38),
        fontSize: 9,
        lineHeight: 1.45,
        color: INK,
    },
    content: {
        paddingLeft: mm(MARGIN_LEFT),
        paddingRight: mm(MARGIN_RIGHT),
    },

    mark: {
        position: "absolute",
        left: mm(6.5),
        borderTopWidth: 0.5,
        borderColor: RULE,
    },

    /** Small, wide-tracked, upper-case: the site's section eyebrows. */
    label: {
        fontSize: 6.5,
        fontWeight: 500,
        letterSpacing: 0.7,
        textTransform: "uppercase",
        color: FAINT,
    },

    letterhead: {
        height: mm(ADDRESS_TOP),
        justifyContent: "flex-end",
        paddingBottom: mm(6),
    },
    letterheadRule: {
        borderBottomWidth: 0.5,
        borderColor: RULE,
        paddingBottom: 5,
    },
    brand: { fontSize: 14, fontWeight: 600, letterSpacing: -0.2 },
    brandMuted: { color: FAINT, fontWeight: 400 },

    addressRow: { flexDirection: "row", height: mm(45) },
    addressField: { width: mm(ADDRESS_WIDTH) },
    returnZone: {
        height: mm(ADDRESS_ZONE_TOP),
        justifyContent: "flex-end",
        paddingBottom: 4,
    },
    returnLine: { fontSize: 6.5, color: MUTED },
    addressLine: { fontSize: 10.5, lineHeight: 1.4 },

    infoBlock: {
        // Fills the rest of the line so the block aligns on the right margin;
        // without it the block shrink-wraps its widest row.
        flexGrow: 1,
        alignItems: "flex-end",
        marginLeft: mm(INFO_BLOCK_LEFT - MARGIN_LEFT - ADDRESS_WIDTH),
    },
    infoEntry: { alignItems: "flex-end", marginBottom: 5 },
    infoValue: { fontSize: 9, fontWeight: 500, lineHeight: 1.3 },

    subjectGap: { height: mm(SUBJECT_TOP - ADDRESS_TOP - 45) },
    subject: {
        fontSize: 16,
        fontWeight: 600,
        letterSpacing: -0.3,
        lineHeight: 1.25,
    },
    subjectNote: { fontSize: 10, color: MUTED, marginTop: 4 },

    intro: { marginTop: mm(7) },
    introText: { marginTop: mm(3) },

    tableHead: {
        flexDirection: "row",
        marginTop: mm(7),
        paddingBottom: 5,
        borderBottomWidth: 0.5,
        borderColor: RULE,
    },
    tableRow: {
        flexDirection: "row",
        paddingTop: 6.5,
        paddingBottom: 6.5,
        borderBottomWidth: 0.5,
        borderColor: HAIRLINE,
    },
    itemName: { fontWeight: 500 },
    itemDetail: { fontSize: 8, color: MUTED, marginTop: 1.5 },

    colPos: { width: "6%", color: FAINT },
    colDesc: { width: "48%", paddingRight: 12 },
    colQty: { width: "15%", textAlign: "right", color: MUTED },
    colPrice: { width: "15%", textAlign: "right", color: MUTED },
    colSum: { width: "16%", textAlign: "right" },

    totals: { alignItems: "flex-end", marginTop: mm(4) },
    totalsBlock: { width: "48%" },
    grandRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        borderTopWidth: 0.5,
        borderColor: RULE,
        paddingTop: 8,
    },
    grandValue: { fontSize: 14, fontWeight: 600, letterSpacing: -0.3 },

    exempt: { fontSize: 8, color: MUTED, marginTop: mm(3.5) },
    paragraph: { marginTop: mm(4.5) },
    signature: { marginTop: mm(7), fontWeight: 500 },

    footer: {
        position: "absolute",
        bottom: mm(14),
        left: mm(MARGIN_LEFT),
        right: mm(MARGIN_RIGHT),
        flexDirection: "row",
        borderTopWidth: 0.5,
        borderColor: HAIRLINE,
        paddingTop: 7,
        fontSize: 6.8,
        lineHeight: 1.55,
        color: FAINT,
    },
    footerColumn: { width: "33.33%", paddingRight: 12 },
    footerHeading: { marginBottom: 3 },
    pageNumber: {
        position: "absolute",
        bottom: mm(8),
        right: mm(MARGIN_RIGHT),
        fontSize: 6.8,
        color: FAINT,
    },
});

export type PdfLine = Totals["lines"][number] & { detail?: string | null };

export type DocumentPdfInput = {
    kind: "invoice" | "offer";
    /**
     * A draft has no number yet and must not read as a payable document; a
     * correction reverses an invoice and carries its lines with a negated
     * quantity.
     */
    variant?: "draft" | "correction" | null;
    number: string;
    /** Optional line beneath the heading, such as an offer's title. */
    title?: string | null;
    recipient: string;
    customerNumber: number | null;
    issuedAt: Date;
    dueAt?: Date | null;
    validUntil?: Date | null;
    servicePeriod?: { start: Date | null; end: Date | null };
    introText?: string | null;
    note?: string | null;
    totals: Totals;
    details?: (string | null)[];
};

const KIND_LABEL = { invoice: "Rechnung", offer: "Angebot" } as const;

const DEFAULT_INTRO = {
    invoice:
        "vielen Dank für Ihr Vertrauen. Wir stellen Ihnen die folgenden Leistungen in Rechnung:",
    offer: "vielen Dank für Ihr Interesse. Gerne unterbreiten wir Ihnen folgendes Angebot:",
} as const;

const CORRECTION_INTRO =
    "hiermit korrigieren wir die nachfolgend genannte Rechnung vollständig. Die ursprünglichen Positionen sind mit umgekehrtem Vorzeichen aufgeführt.";

function FoldMarks() {
    // 87 mm and 192 mm fold the sheet into thirds for a DIN-lang envelope;
    // 148.5 mm is the punch mark at the exact half of the page.
    return (
        <>
            <View style={[styles.mark, { top: mm(87), width: mm(6) }]} fixed />
            <View
                style={[styles.mark, { top: mm(148.5), width: mm(10) }]}
                fixed
            />
            <View style={[styles.mark, { top: mm(192), width: mm(6) }]} fixed />
        </>
    );
}

function DocumentPdf(input: DocumentPdfInput & { settings: Settings }) {
    const { bank, operator, policy, site } = input.settings;

    const isInvoice = input.kind === "invoice";
    const isDraft = input.variant === "draft";
    const isCorrection = input.variant === "correction";

    const label = isCorrection
        ? "Rechnungskorrektur"
        : isDraft
          ? `${KIND_LABEL[input.kind]}entwurf`
          : KIND_LABEL[input.kind];

    // A draft has nothing to reference yet, so the number is left off entirely
    // rather than printed as a placeholder that looks like one.
    const heading = isDraft ? label : `${label} ${input.number}`;

    const info: [string, string][] = [
        ...(input.customerNumber
            ? ([["Kundennummer", String(input.customerNumber)]] as [
                  string,
                  string,
              ][])
            : []),
        [
            isInvoice ? "Rechnungsdatum" : "Angebotsdatum",
            formatDate(input.issuedAt),
        ],
        ...(isInvoice && input.dueAt
            ? ([["Fällig am", formatDate(input.dueAt)]] as [string, string][])
            : []),
        ...(!isInvoice && input.validUntil
            ? ([["Gültig bis", formatDate(input.validUntil)]] as [
                  string,
                  string,
              ][])
            : []),
        ...(input.servicePeriod?.start
            ? ([
                  [
                      "Leistungszeitraum",
                      formatDateRange(
                          input.servicePeriod.start,
                          input.servicePeriod.end,
                      ),
                  ],
              ] as [string, string][])
            : []),
    ];

    return (
        <Document
            title={heading}
            author={operator.name}
            subject={input.title ?? heading}
            creator={site.name}
        >
            <Page size="A4" style={styles.page}>
                <FoldMarks />

                <View style={styles.content}>
                    <View style={styles.letterhead}>
                        <View style={styles.letterheadRule}>
                            <Text style={styles.brand}>
                                virtify
                                <Text style={styles.brandMuted}>.net</Text>
                            </Text>
                        </View>
                    </View>

                    <View style={styles.addressRow}>
                        <View style={styles.addressField}>
                            <View style={styles.returnZone}>
                                <Text style={styles.returnLine}>
                                    {operator.name} · {operator.street} ·{" "}
                                    {operator.city}
                                </Text>
                            </View>
                            {input.recipient.split("\n").map((line) => (
                                <Text key={line} style={styles.addressLine}>
                                    {line}
                                </Text>
                            ))}
                        </View>

                        <View style={styles.infoBlock}>
                            {info.map(([label, value]) => (
                                <View key={label} style={styles.infoEntry}>
                                    <Text style={styles.label}>{label}</Text>
                                    <Text style={styles.infoValue}>
                                        {value}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    </View>

                    <View style={styles.subjectGap} />
                    <Text style={styles.subject}>{heading}</Text>
                    {input.title ? (
                        <Text style={styles.subjectNote}>{input.title}</Text>
                    ) : null}

                    <Text style={styles.intro}>
                        Sehr geehrte Damen und Herren,
                    </Text>
                    <Text style={styles.introText}>
                        {input.introText ||
                            (isCorrection
                                ? CORRECTION_INTRO
                                : DEFAULT_INTRO[input.kind])}
                    </Text>

                    <View style={styles.tableHead}>
                        <Text style={[styles.label, styles.colPos]}>Pos.</Text>
                        <Text style={[styles.label, styles.colDesc]}>
                            Leistung
                        </Text>
                        <Text style={[styles.label, styles.colQty]}>Menge</Text>
                        <Text style={[styles.label, styles.colPrice]}>
                            Einzelpreis
                        </Text>
                        <Text style={[styles.label, styles.colSum]}>
                            Betrag
                        </Text>
                    </View>

                    {input.totals.lines.map((item, index) => (
                        <View
                            key={item.position}
                            style={styles.tableRow}
                            wrap={false}
                        >
                            <Text style={styles.colPos}>{item.position}</Text>
                            <View style={styles.colDesc}>
                                <Text style={styles.itemName}>
                                    {item.description}
                                </Text>
                                {input.details?.[index] ? (
                                    <Text style={styles.itemDetail}>
                                        {input.details[index]}
                                    </Text>
                                ) : null}
                            </View>
                            <Text style={styles.colQty}>
                                {formatQuantity(item.quantity, item.unitCode)}
                            </Text>
                            <Text style={styles.colPrice}>
                                {formatPrice(item.unitPriceCents)}
                            </Text>
                            <Text style={styles.colSum}>
                                {formatPrice(item.lineTotalCents)}
                            </Text>
                        </View>
                    ))}

                    <View style={styles.totals}>
                        <View style={styles.totalsBlock}>
                            <View style={styles.grandRow}>
                                <Text style={styles.label}>Gesamtbetrag</Text>
                                <Text style={styles.grandValue}>
                                    {formatPrice(input.totals.grossCents)}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/*
                     * § 19 UStG: no VAT is shown anywhere on the document — not
                     * even as a zero line — and the reason stands next to the
                     * total, where a tax breakdown would otherwise be.
                     */}
                    <Text style={styles.exempt}>
                        Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer
                        berechnet.
                    </Text>

                    {isDraft ? (
                        <Text style={styles.paragraph}>
                            Dies ist ein Entwurf und keine Rechnung im Sinne des
                            § 14 UStG. Bitte leisten Sie hierauf keine Zahlung.
                        </Text>
                    ) : isCorrection ? (
                        <Text style={styles.paragraph}>
                            Diese Rechnungskorrektur hebt die genannte Rechnung
                            vollständig auf. Eine Zahlung ist hierauf nicht zu
                            leisten; bereits gezahlte Beträge erstatten wir auf
                            das uns bekannte Konto.
                        </Text>
                    ) : isInvoice ? (
                        <Text style={styles.paragraph}>
                            Bitte überweisen Sie den Gesamtbetrag ohne Abzug
                            {input.dueAt
                                ? ` bis zum ${formatDate(input.dueAt)}`
                                : ` innerhalb von ${policy.paymentTermDays} Tagen nach Erhalt dieser Rechnung`}{" "}
                            auf das unten genannte Konto und geben Sie dabei{" "}
                            {input.number} als Verwendungszweck an.
                        </Text>
                    ) : (
                        <Text style={styles.paragraph}>
                            Annehmen können Sie dieses Angebot in Ihrem
                            Kundenbereich unter {site.url}/account/offers; mit
                            der Annahme kommt der Vertrag zustande.
                        </Text>
                    )}

                    {input.note ? (
                        <Text style={styles.paragraph}>{input.note}</Text>
                    ) : null}

                    <Text style={styles.signature}>
                        Mit freundlichen Grüßen
                    </Text>
                    <Text>{operator.name}</Text>
                </View>

                <View style={styles.footer} fixed>
                    <View style={styles.footerColumn}>
                        <Text style={[styles.label, styles.footerHeading]}>
                            Anschrift
                        </Text>
                        <Text>{operator.name}</Text>
                        <Text>{operator.street}</Text>
                        <Text>{operator.city}</Text>
                        <Text>{operator.country}</Text>
                    </View>
                    <View style={styles.footerColumn}>
                        <Text style={[styles.label, styles.footerHeading]}>
                            Bankverbindung
                        </Text>
                        <Text>{bank.name}</Text>
                        <Text>IBAN: {bank.iban}</Text>
                        <Text>BIC: {bank.bic}</Text>
                    </View>
                    <View style={styles.footerColumn}>
                        <Text style={[styles.label, styles.footerHeading]}>
                            Kontakt
                        </Text>
                        <Text>{site.url}</Text>
                        <Text>{operator.phone}</Text>
                        <Text>{operator.email}</Text>
                        <Text>USt-IdNr. {operator.vatId}</Text>
                    </View>
                </View>

                <Text
                    style={styles.pageNumber}
                    render={({ pageNumber, totalPages }) =>
                        totalPages > 1
                            ? `Seite ${pageNumber} von ${totalPages}`
                            : ""
                    }
                    fixed
                />
            </Page>
        </Document>
    );
}

export async function renderDocumentPdf(input: DocumentPdfInput) {
    // Loaded here rather than imported, so an address changed in the admin
    // area appears on the next document instead of the next deployment.
    const settings = await loadSettings();

    return renderToBuffer(<DocumentPdf {...input} settings={settings} />);
}
