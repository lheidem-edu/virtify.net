import {
    Document,
    Page,
    renderToBuffer,
    StyleSheet,
    Text,
    View,
} from "@react-pdf/renderer";
import { legalUpdated, operator, site } from "@/lib/site";

const styles = StyleSheet.create({
    page: {
        paddingTop: 64,
        paddingBottom: 56,
        paddingHorizontal: 64,
        fontSize: 10.5,
        lineHeight: 1.6,
        color: "#18181b",
    },
    eyebrow: {
        fontSize: 8,
        letterSpacing: 2,
        color: "#71717a",
        textTransform: "uppercase",
    },
    title: { fontSize: 18, marginTop: 14, marginBottom: 8 },
    rule: {
        borderBottomWidth: 0.5,
        borderColor: "#d4d4d8",
        marginVertical: 18,
    },
    hint: { color: "#52525b", marginBottom: 18 },
    label: { color: "#52525b", marginBottom: 4 },
    block: { marginBottom: 18 },
    field: {
        borderBottomWidth: 0.5,
        borderColor: "#a1a1aa",
        height: 20,
        marginTop: 10,
    },
    fieldHalf: {
        borderBottomWidth: 0.5,
        borderColor: "#a1a1aa",
        height: 20,
        marginTop: 10,
        width: "48%",
    },
    row: { flexDirection: "row", justifyContent: "space-between" },
    footnote: { fontSize: 8.5, color: "#71717a", marginTop: 20 },
    footnoteTight: { fontSize: 8.5, color: "#71717a", marginTop: 4 },
    footer: {
        position: "absolute",
        bottom: 28,
        left: 64,
        right: 64,
        fontSize: 8,
        color: "#a1a1aa",
        borderTopWidth: 0.5,
        borderColor: "#e4e4e7",
        paddingTop: 8,
        flexDirection: "row",
        justifyContent: "space-between",
    },
});

/** Muster-Widerrufsformular nach Anlage 2 zu Art. 246a § 1 Abs. 2 Satz 1 Nr. 1 EGBGB. */
function Widerrufsformular() {
    return (
        <Document
            title={`Muster-Widerrufsformular — ${site.name}`}
            author={operator.name}
            subject="Muster-Widerrufsformular nach Anlage 2 zu Art. 246a EGBGB"
        >
            <Page size="A4" style={styles.page}>
                <Text style={styles.eyebrow}>{site.name}</Text>
                <Text style={styles.title}>Muster-Widerrufsformular</Text>
                <Text style={styles.hint}>
                    Wenn Sie den Vertrag widerrufen wollen, füllen Sie bitte
                    dieses Formular aus und senden Sie es zurück.
                </Text>

                <View style={styles.rule} />

                <View style={styles.block}>
                    <Text style={styles.label}>An</Text>
                    <Text>{operator.name}</Text>
                    <Text>{operator.street}</Text>
                    <Text>
                        {operator.city}, {operator.country}
                    </Text>
                    <Text>E-Mail: {operator.email}</Text>
                </View>

                <View style={styles.block}>
                    <Text>
                        Hiermit widerrufe(n) ich/wir (*) den von mir/uns (*)
                        abgeschlossenen Vertrag über den Kauf der folgenden
                        Waren (*) / die Erbringung der folgenden Dienstleistung
                        (*)
                    </Text>
                    <View style={styles.field} />
                    <View style={styles.field} />
                </View>

                <View style={styles.block}>
                    <View style={styles.row}>
                        <View style={{ width: "48%" }}>
                            <Text style={styles.label}>Bestellt am (*)</Text>
                            <View style={styles.field} />
                        </View>
                        <View style={{ width: "48%" }}>
                            <Text style={styles.label}>Erhalten am (*)</Text>
                            <View style={styles.field} />
                        </View>
                    </View>
                </View>

                <View style={styles.block}>
                    <Text style={styles.label}>
                        Name des/der Verbraucher(s)
                    </Text>
                    <View style={styles.field} />
                </View>

                <View style={styles.block}>
                    <Text style={styles.label}>
                        Anschrift des/der Verbraucher(s)
                    </Text>
                    <View style={styles.field} />
                    <View style={styles.field} />
                </View>

                <View style={styles.block}>
                    <View style={styles.row}>
                        <View style={{ width: "48%" }}>
                            <Text style={styles.label}>
                                Unterschrift (nur auf Papier)
                            </Text>
                            <View style={styles.field} />
                        </View>
                        <View style={{ width: "48%" }}>
                            <Text style={styles.label}>Datum</Text>
                            <View style={styles.field} />
                        </View>
                    </View>
                </View>

                <Text style={styles.footnote}>
                    (*) Unzutreffendes streichen.
                </Text>
                <Text style={styles.footnoteTight}>
                    Muster-Widerrufsformular nach Anlage 2 zu Art. 246a § 1 Abs.
                    2 Satz 1 Nr. 1 EGBGB.
                </Text>

                <View style={styles.footer} fixed>
                    <Text>{site.url}</Text>
                    <Text>Stand: {legalUpdated}</Text>
                </View>
            </Page>
        </Document>
    );
}

export async function GET() {
    const buffer = await renderToBuffer(<Widerrufsformular />);

    return new Response(new Uint8Array(buffer), {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition":
                'inline; filename="withdrawal-virtify-net.pdf"',
            "Cache-Control": "public, max-age=3600",
        },
    });
}
