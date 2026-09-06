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
    formatDate,
    formatDateRange,
    formatPrice,
    UNIT_LABEL,
} from "@/lib/format";
import { bank, operator, site } from "@/lib/site";

/**
 * Business letter per DIN 5008 Form B. The measurements below are the
 * standard's, not taste: the address field sits at 45 mm so it shows through
 * a DIN-lang window envelope, the subject line at 98.46 mm, and the fold and
 * hole marks at 87 / 148.5 / 192 mm so the sheet folds and files correctly.
 */

/** DIN measurements are in millimetres; PDF units are points. */
const mm = (value: number) => value * 2.8346;

const MARGIN_LEFT = 24.1;
const MARGIN_RIGHT = 20;
const ADDRESS_TOP = 45;
const ADDRESS_WIDTH = 85;
/** Zusatz- und Vermerkzone: five lines above the address itself. */
const ADDRESS_ZONE_TOP = 17.7;
const INFO_BLOCK_LEFT = 125;
const SUBJECT_TOP = 98.46;

const INK = "#18181b";
const MUTED = "#52525b";
const FAINT = "#8a8a94";
const RULE = "#c8c8ce";

const styles = StyleSheet.create({
    page: {
        paddingBottom: mm(38),
        fontSize: 9.5,
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

    letterhead: {
        height: mm(ADDRESS_TOP),
        justifyContent: "flex-end",
        paddingBottom: mm(6),
    },
    brand: { fontSize: 15 },
    brandMuted: { color: FAINT },

    addressRow: { flexDirection: "row", height: mm(45) },
    addressField: { width: mm(ADDRESS_WIDTH) },
    returnZone: {
        height: mm(ADDRESS_ZONE_TOP),
        justifyContent: "flex-end",
        paddingBottom: 3,
    },
    returnLine: { fontSize: 6.5, color: MUTED },
    addressLine: { fontSize: 11, lineHeight: 1.35 },

    infoBlock: {
        // Fills the rest of the line so space-between actually has space;
        // without it the block shrink-wraps its widest row.
        flexGrow: 1,
        marginLeft: mm(INFO_BLOCK_LEFT - MARGIN_LEFT - ADDRESS_WIDTH),
    },
    infoRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        marginBottom: 1.5,
    },
    infoLabel: { color: MUTED },
    infoValue: { textAlign: "right" },

    subjectGap: { height: mm(SUBJECT_TOP - ADDRESS_TOP - 45) },
    subject: { fontSize: 14, marginBottom: mm(8) },

    intro: { marginBottom: mm(6) },

    tableHead: {
        flexDirection: "row",
        borderBottomWidth: 0.75,
        borderColor: INK,
        paddingBottom: 4,
        fontSize: 8.5,
    },
    tableRow: { flexDirection: "row", paddingTop: 7 },
    rowRule: { borderBottomWidth: 0.5, borderColor: RULE, marginTop: 7 },
    detail: { fontSize: 8, color: MUTED, marginTop: 2 },

    colPos: { width: "7%" },
    colDesc: { width: "39%" },
    colQty: { width: "12%", textAlign: "right" },
    colUnit: { width: "12%", textAlign: "right" },
    colPrice: { width: "15%", textAlign: "right" },
    colSum: { width: "15%", textAlign: "right" },

    totalsWrap: { alignItems: "flex-end", marginTop: mm(4) },
    totalsRow: {
        flexDirection: "row",
        width: "46%",
        justifyContent: "space-between",
        paddingVertical: 2,
    },
    totalsStrong: {
        flexDirection: "row",
        width: "46%",
        justifyContent: "space-between",
        borderTopWidth: 0.75,
        borderBottomWidth: 0.75,
        borderColor: INK,
        paddingVertical: 5,
        marginTop: 3,
        fontSize: 11,
    },

    paragraph: { marginTop: mm(5) },
    closing: { marginTop: mm(7) },
    signature: { marginTop: mm(5) },

    footer: {
        position: "absolute",
        bottom: mm(14),
        left: mm(MARGIN_LEFT),
        right: mm(MARGIN_RIGHT),
        flexDirection: "row",
        fontSize: 7,
        lineHeight: 1.5,
        color: FAINT,
    },
    footerColumn: { width: "33.33%", paddingRight: 10 },
    footerHeading: { marginBottom: 4 },
    pageNumber: {
        position: "absolute",
        bottom: mm(8),
        right: mm(MARGIN_RIGHT),
        fontSize: 7,
        color: FAINT,
    },
});

export type PdfLine = Totals["lines"][number] & { detail?: string | null };

export type DocumentPdfInput = {
    kind: "invoice" | "offer";
    number: string;
    subject: string;
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

const DEFAULT_INTRO = {
    invoice:
        "vielen Dank für Ihr entgegengebrachtes Vertrauen. Wir erlauben uns, Ihnen nachfolgende Leistungen in Rechnung zu stellen:",
    offer: "vielen Dank für Ihr Interesse. Gerne unterbreiten wir Ihnen folgendes Angebot:",
} as const;

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

function DocumentPdf(input: DocumentPdfInput) {
    const isInvoice = input.kind === "invoice";

    const info: [string, string][] = [
        [isInvoice ? "Rechnungs-Nr." : "Angebots-Nr.", input.number],
        ...(input.customerNumber
            ? ([["Kunden-Nr.", String(input.customerNumber)]] as [
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
            title={`${input.subject} ${input.number}`}
            author={operator.name}
            subject={input.subject}
            creator={site.name}
        >
            <Page size="A4" style={styles.page}>
                <FoldMarks />

                <View style={styles.content}>
                    <View style={styles.letterhead}>
                        <Text style={styles.brand}>
                            virtify<Text style={styles.brandMuted}>.net</Text>
                        </Text>
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
                                <View key={label} style={styles.infoRow}>
                                    <Text style={styles.infoLabel}>
                                        {label}
                                    </Text>
                                    <Text style={styles.infoValue}>
                                        {value}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    </View>

                    <View style={styles.subjectGap} />
                    <Text style={styles.subject}>{input.subject}</Text>

                    <Text style={styles.intro}>
                        Sehr geehrte Damen und Herren,
                    </Text>
                    <Text style={styles.intro}>
                        {input.introText || DEFAULT_INTRO[input.kind]}
                    </Text>

                    <View style={styles.tableHead}>
                        <Text style={styles.colPos}>Pos.</Text>
                        <Text style={styles.colDesc}>Artikel / Leistung</Text>
                        <Text style={styles.colQty}>Menge</Text>
                        <Text style={styles.colUnit}>Einheit</Text>
                        <Text style={styles.colPrice}>Preis</Text>
                        <Text style={styles.colSum}>Gesamt</Text>
                    </View>

                    {input.totals.lines.map((item, index) => (
                        <View key={item.position} wrap={false}>
                            <View style={styles.tableRow}>
                                <Text style={styles.colPos}>
                                    {item.position}.
                                </Text>
                                <View style={styles.colDesc}>
                                    <Text>{item.description}</Text>
                                    {input.details?.[index] ? (
                                        <Text style={styles.detail}>
                                            {input.details[index]}
                                        </Text>
                                    ) : null}
                                </View>
                                <Text style={styles.colQty}>
                                    {item.quantity.toLocaleString("de-DE", {
                                        minimumFractionDigits: 2,
                                    })}
                                </Text>
                                <Text style={styles.colUnit}>
                                    {UNIT_LABEL[item.unitCode] ?? item.unitCode}
                                </Text>
                                <Text style={styles.colPrice}>
                                    {formatPrice(item.unitPriceCents)}
                                </Text>
                                <Text style={styles.colSum}>
                                    {formatPrice(item.lineTotalCents)}
                                </Text>
                            </View>
                            <View style={styles.rowRule} />
                        </View>
                    ))}

                    <View style={styles.totalsWrap}>
                        <View style={styles.totalsRow}>
                            <Text style={styles.infoLabel}>Nettobetrag</Text>
                            <Text>{formatPrice(input.totals.netCents)}</Text>
                        </View>
                        <View style={styles.totalsRow}>
                            <Text style={styles.infoLabel}>
                                Umsatzsteuer (0 %)
                            </Text>
                            <Text>{formatPrice(input.totals.taxCents)}</Text>
                        </View>
                        <View style={styles.totalsStrong}>
                            <Text>Gesamtbetrag</Text>
                            <Text>{formatPrice(input.totals.grossCents)}</Text>
                        </View>
                    </View>

                    {isInvoice ? (
                        <Text style={styles.paragraph}>
                            Zahlbar innerhalb von 14 Tagen nach Erhalt der
                            Rechnung ohne Abzug auf das unten genannte Konto.
                        </Text>
                    ) : (
                        <Text style={styles.paragraph}>
                            Dieses Angebot können Sie in Ihrem Kundenbereich
                            unter {site.url}/account/offers annehmen. Mit der
                            Annahme kommt der Vertrag zustande.
                        </Text>
                    )}

                    <Text style={styles.paragraph}>
                        Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer
                        berechnet.
                    </Text>

                    {input.note ? (
                        <Text style={styles.paragraph}>{input.note}</Text>
                    ) : null}

                    <Text style={styles.closing}>
                        Für Rückfragen stehen wir Ihnen selbstverständlich gerne
                        zur Verfügung und danken Ihnen für die angenehme
                        Zusammenarbeit.
                    </Text>

                    <Text style={styles.signature}>
                        Mit freundlichen Grüßen
                    </Text>
                    <Text>{operator.name}</Text>
                </View>

                <View style={styles.footer} fixed>
                    <View style={styles.footerColumn}>
                        <Text style={styles.footerHeading}>Anschrift</Text>
                        <Text>{operator.name}</Text>
                        <Text>{operator.street}</Text>
                        <Text>{operator.city}</Text>
                        <Text>{operator.country}</Text>
                    </View>
                    <View style={styles.footerColumn}>
                        <Text style={styles.footerHeading}>Bankverbindung</Text>
                        <Text>{bank.name}</Text>
                        <Text>IBAN: {bank.iban}</Text>
                        <Text>BIC: {bank.bic}</Text>
                    </View>
                    <View style={styles.footerColumn}>
                        <Text style={styles.footerHeading}>
                            Weitere Informationen
                        </Text>
                        <Text>{site.url}</Text>
                        <Text>Telefon: {operator.phone}</Text>
                        <Text>E-Mail: {operator.email}</Text>
                        <Text>USt-IdNr.: {operator.vatId}</Text>
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
    return renderToBuffer(<DocumentPdf {...input} />);
}
