import {
    Document,
    Page,
    renderToBuffer,
    StyleSheet,
    Text,
    View,
} from "@react-pdf/renderer";
import type { Totals } from "@/lib/documents/totals";
import { formatDate, formatPrice } from "@/lib/format";
import { operator, site } from "@/lib/site";

const styles = StyleSheet.create({
    page: {
        paddingTop: 56,
        paddingBottom: 72,
        paddingHorizontal: 56,
        fontSize: 9.5,
        lineHeight: 1.55,
        color: "#18181b",
    },
    brand: { fontSize: 13, marginBottom: 2 },
    brandMuted: { color: "#a1a1aa" },
    sender: { fontSize: 7.5, color: "#71717a", marginBottom: 28 },
    row: { flexDirection: "row", justifyContent: "space-between" },
    addressBlock: { width: "55%" },
    metaBlock: { width: "40%" },
    metaRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        marginBottom: 2,
    },
    metaLabel: { color: "#71717a" },
    title: { fontSize: 16, marginTop: 34, marginBottom: 10 },
    intro: { color: "#3f3f46", marginBottom: 18 },
    tableHead: {
        flexDirection: "row",
        borderBottomWidth: 0.75,
        borderColor: "#18181b",
        paddingBottom: 5,
        fontSize: 8,
        color: "#52525b",
    },
    tableRow: {
        flexDirection: "row",
        borderBottomWidth: 0.5,
        borderColor: "#e4e4e7",
        paddingVertical: 7,
    },
    colPos: { width: "7%" },
    colDesc: { width: "45%" },
    colQty: { width: "16%", textAlign: "right" },
    colUnit: { width: "16%", textAlign: "right" },
    colSum: { width: "16%", textAlign: "right" },
    totalsWrap: { alignItems: "flex-end", marginTop: 14 },
    totalsRow: {
        flexDirection: "row",
        width: "55%",
        justifyContent: "space-between",
        paddingVertical: 3,
    },
    totalsStrong: {
        flexDirection: "row",
        width: "55%",
        justifyContent: "space-between",
        borderTopWidth: 0.75,
        borderColor: "#18181b",
        paddingTop: 6,
        marginTop: 3,
        fontSize: 11,
    },
    note: { marginTop: 26, color: "#3f3f46" },
    legal: { marginTop: 14, fontSize: 8, color: "#71717a" },
    footer: {
        position: "absolute",
        bottom: 32,
        left: 56,
        right: 56,
        borderTopWidth: 0.5,
        borderColor: "#e4e4e7",
        paddingTop: 7,
        fontSize: 7.5,
        color: "#a1a1aa",
        flexDirection: "row",
        justifyContent: "space-between",
    },
});

export type DocumentPdfInput = {
    kind: "invoice" | "offer";
    number: string;
    title: string;
    recipient: string;
    issuedAt: Date;
    dueAt?: Date | null;
    validUntil?: Date | null;
    servicePeriod?: { start: Date | null; end: Date | null };
    introText?: string | null;
    note?: string | null;
    totals: Totals;
};

const KLEINUNTERNEHMER =
    "Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet.";

function DocumentPdf(input: DocumentPdfInput) {
    const isInvoice = input.kind === "invoice";

    const meta: [string, string][] = [
        [isInvoice ? "Rechnungsnummer" : "Angebotsnummer", input.number],
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
                      `${formatDate(input.servicePeriod.start)} – ${formatDate(input.servicePeriod.end)}`,
                  ],
              ] as [string, string][])
            : []),
    ];

    return (
        <Document
            title={`${input.title} ${input.number}`}
            author={operator.name}
            subject={input.title}
        >
            <Page size="A4" style={styles.page}>
                <Text style={styles.brand}>
                    virtify<Text style={styles.brandMuted}>.net</Text>
                </Text>
                <Text style={styles.sender}>
                    {operator.name} · {operator.street} · {operator.city}
                </Text>

                <View style={styles.row}>
                    <View style={styles.addressBlock}>
                        <Text>{input.recipient}</Text>
                    </View>
                    <View style={styles.metaBlock}>
                        {meta.map(([label, value]) => (
                            <View key={label} style={styles.metaRow}>
                                <Text style={styles.metaLabel}>{label}</Text>
                                <Text>{value}</Text>
                            </View>
                        ))}
                    </View>
                </View>

                <Text style={styles.title}>{input.title}</Text>
                {input.introText ? (
                    <Text style={styles.intro}>{input.introText}</Text>
                ) : null}

                <View style={styles.tableHead}>
                    <Text style={styles.colPos}>Pos.</Text>
                    <Text style={styles.colDesc}>Bezeichnung</Text>
                    <Text style={styles.colQty}>Menge</Text>
                    <Text style={styles.colUnit}>Einzelpreis</Text>
                    <Text style={styles.colSum}>Betrag</Text>
                </View>

                {input.totals.lines.map((item) => (
                    <View key={item.position} style={styles.tableRow}>
                        <Text style={styles.colPos}>{item.position}</Text>
                        <Text style={styles.colDesc}>{item.description}</Text>
                        <Text style={styles.colQty}>{item.quantity}</Text>
                        <Text style={styles.colUnit}>
                            {formatPrice(item.unitPriceCents)}
                        </Text>
                        <Text style={styles.colSum}>
                            {formatPrice(item.lineTotalCents)}
                        </Text>
                    </View>
                ))}

                <View style={styles.totalsWrap}>
                    <View style={styles.totalsRow}>
                        <Text style={styles.metaLabel}>Nettobetrag</Text>
                        <Text>{formatPrice(input.totals.netCents)}</Text>
                    </View>
                    <View style={styles.totalsRow}>
                        <Text style={styles.metaLabel}>Umsatzsteuer</Text>
                        <Text>{formatPrice(input.totals.taxCents)}</Text>
                    </View>
                    <View style={styles.totalsStrong}>
                        <Text>Gesamtbetrag</Text>
                        <Text>{formatPrice(input.totals.grossCents)}</Text>
                    </View>
                </View>

                {input.note ? (
                    <Text style={styles.note}>{input.note}</Text>
                ) : null}
                <Text style={styles.legal}>{KLEINUNTERNEHMER}</Text>
                {isInvoice ? (
                    <Text style={styles.legal}>
                        Zahlbar ohne Abzug auf das Ihnen bekannte Konto.
                    </Text>
                ) : null}

                <View style={styles.footer} fixed>
                    <Text>
                        {operator.name} · {operator.email}
                    </Text>
                    <Text>
                        {site.url} · USt-IdNr. {operator.vatId}
                    </Text>
                </View>
            </Page>
        </Document>
    );
}

export async function renderDocumentPdf(input: DocumentPdfInput) {
    return renderToBuffer(<DocumentPdf {...input} />);
}
