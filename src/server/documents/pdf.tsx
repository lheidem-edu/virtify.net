import {
    Document,
    Page,
    Path,
    renderToBuffer,
    StyleSheet,
    Svg,
    Text,
    View,
} from "@react-pdf/renderer";
import {
    formatDate,
    formatDateRange,
    formatPrice,
    formatQuantity,
} from "@/lib/format";
import { type GiroCodeInput, giroCodeSymbol } from "@/lib/giro-code";
import type { DocumentTotals } from "@/server/billing/invoices/totals";
import {
    documentFont,
    FAINT,
    HAIRLINE,
    INK,
    MUTED,
    mm,
    RULE,
} from "@/server/documents/typography";
import { loadSettings, type Settings } from "@/server/settings";

/**
 * Business letter per DIN 5008 Form B. The measurements below are the
 * standard's, not taste: the address field sits at 45 mm so it shows through
 * a DIN-lang window envelope, the subject line at 98.46 mm, and the fold and
 * hole marks at 87 / 148.5 / 192 mm so the sheet folds and files correctly.
 *
 * Everything the standard leaves open — type, rules, weight, spacing — follows
 * the website instead: Inter, hairlines, and whitespace doing the work that
 * boxes and bold rules usually do on an invoice.
 *
 * What the document says about tax comes in as data. The renderer never
 * decides a rate, never looks one up and never reads the active strategy: a
 * finalized invoice is re-rendered from its own frozen snapshot, so a
 * document printed in 2031 still shows the 2026 answer.
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
    colDesc: { width: "46%", paddingRight: 12 },
    colQty: { width: "13%", textAlign: "right", color: MUTED },
    colPrice: { width: "13%", textAlign: "right", color: MUTED },
    colTax: { width: "8%", textAlign: "right", color: MUTED },
    colSum: { width: "14%", textAlign: "right" },

    /** Without a tax column the four remaining ones take its width back. */
    colDescWide: { width: "48%", paddingRight: 12 },
    colQtyWide: { width: "15%", textAlign: "right", color: MUTED },
    colPriceWide: { width: "15%", textAlign: "right", color: MUTED },
    colSumWide: { width: "16%", textAlign: "right" },

    totals: { alignItems: "flex-end", marginTop: mm(4) },
    totalsBlock: { width: "48%" },
    totalsRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        paddingTop: 3,
        paddingBottom: 3,
    },
    totalsValue: { fontSize: 9, fontWeight: 500 },
    grandRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        borderTopWidth: 0.5,
        borderColor: RULE,
        paddingTop: 8,
        marginTop: 4,
    },
    grandValue: { fontSize: 14, fontWeight: 600, letterSpacing: -0.3 },

    exempt: { fontSize: 8, color: MUTED, marginTop: mm(3.5) },
    paragraph: { marginTop: mm(4.5) },
    signature: { marginTop: mm(7), fontWeight: 500 },

    payRow: {
        flexDirection: "row",
        marginTop: mm(6),
        alignItems: "flex-start",
    },
    // Explicit widths, not flexGrow: @react-pdf gives a growing child no
    // bound to wrap against, so the paragraph ran its full width and the QR
    // code was drawn on top of it.
    payText: { width: "72%", paddingRight: mm(8) },
    giro: { width: "28%", alignItems: "center" },
    giroCaption: {
        fontSize: 6,
        color: FAINT,
        marginTop: 3,
        textAlign: "center",
    },

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

/** The seller block, as frozen on a document or taken from the settings. */
export type PdfSeller = {
    name: string;
    street: string;
    city: string;
    country: string;
    email: string;
    phone: string;
    /** USt-IdNr., where the operator holds one. */
    vatId: string | null;
    /** Steuernummer — § 14 Abs. 4 Nr. 2 UStG wants one of the two. */
    taxNumber: string | null;
    bankName: string;
    iban: string;
    bic: string;
};

export type DocumentPdfInput = {
    kind: "invoice" | "creditnote" | "offer";
    /** A draft must not read as a payable document. */
    variant?: "draft" | null;
    number: string;
    /** Optional line beneath the heading, such as an offer's title. */
    title?: string | null;
    recipient: string;
    customerNumber: number | null;
    buyerVatId?: string | null;
    issuedAt: Date;
    dueAt?: Date | null;
    validUntil?: Date | null;
    servicePeriod?: { start: Date | null; end: Date | null };
    introText?: string | null;
    note?: string | null;
    totals: DocumentTotals;
    seller: PdfSeller;
    /**
     * Whether a tax column and a tax summary appear at all. Under § 19 UStG
     * they must not: § 19 Abs. 1 Satz 4 forbids showing a tax amount, and a
     * Kleinunternehmer who prints one owes it under § 14c Abs. 2.
     */
    showTax: boolean;
    /** The strategy's sentences, printed where a breakdown would be. */
    taxNotes: string[];
    /** EPC QR for a bank transfer; omitted where nothing is to be paid. */
    giro?: GiroCodeInput | null;
};

const KIND_LABEL = {
    invoice: "Rechnung",
    creditnote: "Rechnungskorrektur",
    offer: "Angebot",
} as const;

const DEFAULT_INTRO = {
    invoice:
        "vielen Dank für Ihr Vertrauen. Wir stellen Ihnen die folgenden Leistungen in Rechnung:",
    creditnote:
        "hiermit korrigieren wir die nachfolgend genannte Rechnung. Die betroffenen Positionen sind unten aufgeführt.",
    offer: "vielen Dank für Ihr Interesse. Gerne unterbreiten wir Ihnen folgendes Angebot:",
} as const;

/** `1900` → "19 %", `2550` → "25,5 %". */
export function formatRate(rateBp: number) {
    return `${(rateBp / 100).toLocaleString("de-DE", {
        maximumFractionDigits: 2,
    })} %`;
}

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

/** The GiroCode, drawn as one path so a 37×37 symbol is one element. */
function GiroCode({ input }: { input: GiroCodeInput }) {
    const symbol = giroCodeSymbol(input);
    const size = mm(24);

    return (
        <View style={styles.giro}>
            <Svg
                width={size}
                height={size}
                viewBox={`0 0 ${symbol.modules} ${symbol.modules}`}
            >
                <Path d={symbol.path} fill={INK} />
            </Svg>
            <Text style={styles.giroCaption}>
                GiroCode — mit der Banking-App scannen
            </Text>
        </View>
    );
}

function DocumentPdf(input: DocumentPdfInput & { settings: Settings }) {
    const { policy, site } = input.settings;
    const seller = input.seller;

    const isInvoice = input.kind === "invoice";
    const isCreditNote = input.kind === "creditnote";
    const isDraft = input.variant === "draft";

    const label = isDraft
        ? `${KIND_LABEL[input.kind]}entwurf`
        : KIND_LABEL[input.kind];

    // A draft has nothing to reference yet, so the number is left off entirely
    // rather than printed as a placeholder that looks like one.
    const heading = isDraft ? label : `${label} ${input.number}`;

    const dateLabel = isInvoice
        ? "Rechnungsdatum"
        : isCreditNote
          ? "Korrekturdatum"
          : "Angebotsdatum";

    const info: [string, string][] = [
        ...(input.customerNumber
            ? ([["Kundennummer", String(input.customerNumber)]] as [
                  string,
                  string,
              ][])
            : []),
        [dateLabel, formatDate(input.issuedAt)],
        ...(isInvoice && input.dueAt
            ? ([["Fällig am", formatDate(input.dueAt)]] as [string, string][])
            : []),
        ...(input.kind === "offer" && input.validUntil
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
        /*
         * The buyer's VAT ID belongs on the document where it does something
         * — a reverse charge, an intra-community supply. Under § 19 UStG it
         * decides nothing, so it is left off rather than printed as
         * decoration.
         */
        ...(input.showTax && input.buyerVatId
            ? ([["USt-IdNr. des Kunden", input.buyerVatId]] as [
                  string,
                  string,
              ][])
            : []),
    ];

    const col = input.showTax
        ? {
              desc: styles.colDesc,
              qty: styles.colQty,
              price: styles.colPrice,
              sum: styles.colSum,
          }
        : {
              desc: styles.colDescWide,
              qty: styles.colQtyWide,
              price: styles.colPriceWide,
              sum: styles.colSumWide,
          };

    return (
        <Document
            title={heading}
            author={seller.name}
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
                                    {seller.name} · {seller.street} ·{" "}
                                    {seller.city}
                                </Text>
                            </View>
                            {input.recipient.split("\n").map((line) => (
                                <Text key={line} style={styles.addressLine}>
                                    {line}
                                </Text>
                            ))}
                        </View>

                        <View style={styles.infoBlock}>
                            {info.map(([key, value]) => (
                                <View key={key} style={styles.infoEntry}>
                                    <Text style={styles.label}>{key}</Text>
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
                        {input.introText || DEFAULT_INTRO[input.kind]}
                    </Text>

                    <View style={styles.tableHead}>
                        <Text style={[styles.label, styles.colPos]}>Pos.</Text>
                        <Text style={[styles.label, col.desc]}>Leistung</Text>
                        <Text style={[styles.label, col.qty]}>Menge</Text>
                        <Text style={[styles.label, col.price]}>
                            Einzelpreis
                        </Text>
                        {input.showTax ? (
                            <Text style={[styles.label, styles.colTax]}>
                                USt.
                            </Text>
                        ) : null}
                        <Text style={[styles.label, col.sum]}>
                            {input.showTax ? "Netto" : "Betrag"}
                        </Text>
                    </View>

                    {input.totals.lines.map((item) => (
                        <View
                            key={item.position}
                            style={styles.tableRow}
                            wrap={false}
                        >
                            <Text style={styles.colPos}>{item.position}</Text>
                            <View style={col.desc}>
                                <Text style={styles.itemName}>
                                    {item.description}
                                </Text>
                                {item.detail ? (
                                    <Text style={styles.itemDetail}>
                                        {item.detail}
                                    </Text>
                                ) : null}
                                {/*
                                 * § 14 Abs. 4 Nr. 6 UStG: the time of the
                                 * supply. A line that covers a different
                                 * period from the document's says so here.
                                 */}
                                {item.servicePeriodStart ? (
                                    <Text style={styles.itemDetail}>
                                        Leistungszeitraum{" "}
                                        {formatDateRange(
                                            item.servicePeriodStart,
                                            item.servicePeriodEnd,
                                        )}
                                    </Text>
                                ) : null}
                            </View>
                            <Text style={col.qty}>
                                {formatQuantity(item.quantity, item.unitCode)}
                            </Text>
                            <Text style={col.price}>
                                {formatPrice(item.unitPriceCents)}
                            </Text>
                            {input.showTax ? (
                                <Text style={styles.colTax}>
                                    {formatRate(item.taxRateBp)}
                                </Text>
                            ) : null}
                            <Text style={col.sum}>
                                {formatPrice(item.netCents)}
                            </Text>
                        </View>
                    ))}

                    <View style={styles.totals}>
                        <View style={styles.totalsBlock}>
                            {input.showTax ? (
                                <>
                                    <View style={styles.totalsRow}>
                                        <Text style={styles.label}>
                                            Nettobetrag
                                        </Text>
                                        <Text style={styles.totalsValue}>
                                            {formatPrice(input.totals.netCents)}
                                        </Text>
                                    </View>
                                    {input.totals.groups.map((group) => (
                                        <View
                                            key={`${group.category}-${group.rateBp}`}
                                            style={styles.totalsRow}
                                        >
                                            <Text style={styles.label}>
                                                {`USt. ${formatRate(group.rateBp)} auf ${formatPrice(group.netCents)}`}
                                            </Text>
                                            <Text style={styles.totalsValue}>
                                                {formatPrice(group.taxCents)}
                                            </Text>
                                        </View>
                                    ))}
                                </>
                            ) : null}
                            <View style={styles.grandRow}>
                                <Text style={styles.label}>Gesamtbetrag</Text>
                                <Text style={styles.grandValue}>
                                    {formatPrice(input.totals.grossCents)}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/*
                     * Where the tax breakdown would otherwise be: the reason
                     * there is none. § 14 Abs. 4 Nr. 8 UStG asks for exactly
                     * that, and the sentence is the strategy's, not this
                     * file's — a document frozen under § 19 keeps saying § 19.
                     */}
                    {input.taxNotes.map((note) => (
                        <Text key={note} style={styles.exempt}>
                            {note}
                        </Text>
                    ))}

                    {isDraft ? (
                        <Text style={styles.paragraph}>
                            Dies ist ein Entwurf und keine Rechnung im Sinne des
                            § 14 UStG. Bitte leisten Sie hierauf keine Zahlung.
                        </Text>
                    ) : isCreditNote ? (
                        <Text style={styles.paragraph}>
                            Diese Rechnungskorrektur nimmt die oben aufgeführten
                            Positionen zurück. Eine Zahlung ist hierauf nicht zu
                            leisten; bereits gezahlte Beträge erstatten wir auf
                            das uns bekannte Konto.
                        </Text>
                    ) : isInvoice ? (
                        <View style={styles.payRow}>
                            <View style={styles.payText}>
                                <Text>
                                    Bitte überweisen Sie den Gesamtbetrag ohne
                                    Abzug
                                    {input.dueAt
                                        ? ` bis zum ${formatDate(input.dueAt)}`
                                        : ` innerhalb von ${policy.paymentTermDays} Tagen nach Erhalt dieser Rechnung`}{" "}
                                    auf das unten genannte Konto und geben Sie
                                    dabei {input.number} als Verwendungszweck
                                    an.
                                </Text>
                            </View>
                            {input.giro ? (
                                <GiroCode input={input.giro} />
                            ) : null}
                        </View>
                    ) : (
                        <Text style={styles.paragraph}>
                            Annehmen können Sie dieses Angebot in Ihrem
                            Kundenbereich unter {site.url}/client/offers; mit
                            der Annahme kommt der Vertrag zustande.
                        </Text>
                    )}

                    {input.note ? (
                        <Text style={styles.paragraph}>{input.note}</Text>
                    ) : null}

                    <Text style={styles.signature}>
                        Mit freundlichen Grüßen
                    </Text>
                    <Text>{seller.name}</Text>
                </View>

                <View style={styles.footer} fixed>
                    <View style={styles.footerColumn}>
                        <Text style={[styles.label, styles.footerHeading]}>
                            Anschrift
                        </Text>
                        <Text>{seller.name}</Text>
                        <Text>{seller.street}</Text>
                        <Text>{seller.city}</Text>
                        <Text>{seller.country}</Text>
                    </View>
                    <View style={styles.footerColumn}>
                        <Text style={[styles.label, styles.footerHeading]}>
                            Bankverbindung
                        </Text>
                        <Text>{seller.bankName}</Text>
                        <Text>IBAN: {seller.iban}</Text>
                        <Text>BIC: {seller.bic}</Text>
                    </View>
                    <View style={styles.footerColumn}>
                        <Text style={[styles.label, styles.footerHeading]}>
                            Kontakt
                        </Text>
                        <Text>{site.url}</Text>
                        <Text>{seller.phone}</Text>
                        <Text>{seller.email}</Text>
                        {/*
                         * § 14 Abs. 4 Nr. 2 UStG: the Steuernummer or the
                         * USt-IdNr. Both are printed where both are held,
                         * because a Kleinunternehmer's customers abroad look
                         * for the one and the Finanzamt for the other.
                         */}
                        {seller.taxNumber ? (
                            <Text>Steuernummer {seller.taxNumber}</Text>
                        ) : null}
                        {seller.vatId ? (
                            <Text>USt-IdNr. {seller.vatId}</Text>
                        ) : null}
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
    // Loaded here rather than imported, so a site name changed in the admin
    // area appears on the next document instead of the next deployment. The
    // seller block is *not* read from here — it is frozen onto the document.
    const settings = await loadSettings();

    return renderToBuffer(<DocumentPdf {...input} settings={settings} />);
}

/** The seller block for a document that has none frozen yet — a draft, an offer. */
export function sellerFromSettings(settings: Settings): PdfSeller {
    return {
        name: settings.operator.name,
        street: settings.operator.street,
        city: settings.operator.city,
        country: settings.operator.country,
        email: settings.operator.email,
        phone: settings.operator.phone,
        vatId: settings.operator.vatId || null,
        taxNumber: settings.operator.taxNumber || null,
        bankName: settings.bank.name,
        iban: settings.bank.iban,
        bic: settings.bank.bic,
    };
}
