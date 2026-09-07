import type { Metadata } from "next";
import LegalList from "@/lib/components/legal/legal-list";
import LegalPage from "@/lib/components/legal/legal-page";
import LegalSection from "@/lib/components/legal/legal-section";
import { operator, policy, site } from "@/lib/site";

export const metadata: Metadata = {
    title: "Datenschutzerklärung",
    description: `Informationen nach Art. 13 und 14 DSGVO zur Verarbeitung personenbezogener Daten durch ${operator.name} (${site.name}).`,
};

const linkClass =
    "text-white underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white";

export default function Page() {
    return (
        <LegalPage
            title="Datenschutzerklärung"
            intro={
                <>
                    <p>
                        Diese Erklärung informiert dich nach Art. 13 und 14
                        DSGVO darüber, welche personenbezogenen Daten wir beim
                        Besuch von {site.name}, bei der Nutzung des
                        Kundenbereichs und im Rahmen der Vertragsabwicklung
                        verarbeiten.
                    </p>
                    <p className="mt-4">
                        Welche der nachstehenden Verarbeitungen tatsächlich
                        stattfinden, hängt davon ab, wie du unsere Angebote
                        nutzt. Für personenbezogene Daten, die du selbst auf
                        einer von uns bereitgestellten Instanz verarbeitest,
                        bist du Verantwortlicher — nicht wir.
                    </p>
                </>
            }
        >
            <LegalSection label="01" title="Verantwortlicher">
                <address className="not-italic">
                    {operator.name}
                    <br />
                    {operator.street}
                    <br />
                    {operator.city}
                    <br />
                    {operator.country}
                </address>
                <p>
                    E-Mail:{" "}
                    <a href={`mailto:${operator.email}`} className={linkClass}>
                        {operator.email}
                    </a>
                </p>
                <p>
                    Ein Datenschutzbeauftragter ist nicht bestellt, da die
                    Voraussetzungen des Art. 37 DSGVO und des § 38 BDSG nicht
                    vorliegen.
                </p>
            </LegalSection>

            <LegalSection label="02" title="Grundsätze">
                <p>
                    Wir verarbeiten personenbezogene Daten nur, soweit dies für
                    den Betrieb der Internetseite, für die Begründung und
                    Durchführung des Vertragsverhältnisses oder zur Erfüllung
                    gesetzlicher Pflichten erforderlich ist. Eine Verarbeitung
                    zu Werbezwecken findet ohne deine Einwilligung nicht statt.
                </p>
                <p>
                    Die Übertragung zwischen deinem Endgerät und unseren Servern
                    ist durchgehend mit TLS verschlüsselt.
                </p>
            </LegalSection>

            <LegalSection label="03" title="Betrieb und Server-Logfiles">
                <p>
                    Diese Internetseite und die bereitgestellten Instanzen
                    laufen auf eigener Hardware von {site.name}. Ein externer
                    Hosting-Dienstleister wird nicht als Auftragsverarbeiter
                    eingesetzt.
                </p>
                <p>
                    Bei jedem Zugriff erfasst der Webserver automatisch
                    Zugriffsdaten in Logdateien:
                </p>
                <LegalList
                    items={[
                        "IP-Adresse des anfragenden Endgeräts",
                        "Datum und Uhrzeit des Zugriffs",
                        "angeforderte Adresse und verwendete HTTP-Methode",
                        "HTTP-Statuscode und übertragene Datenmenge",
                        "Referrer-Adresse, sofern übermittelt",
                        "Browsertyp und Betriebssystem (User-Agent)",
                    ]}
                />
                <p>
                    Zweck ist der technisch fehlerfreie, sichere und stabile
                    Betrieb sowie die Abwehr und Aufklärung von Angriffen.
                    Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; unser
                    berechtigtes Interesse liegt in den genannten Zwecken. Die
                    Logdateien werden spätestens nach {policy.logRetentionDays}{" "}
                    Tagen gelöscht, sofern sie nicht zur Aufklärung eines
                    konkreten Sicherheitsvorfalls ausnahmsweise länger benötigt
                    werden.
                </p>
            </LegalSection>

            <LegalSection label="04" title="Kontaktaufnahme">
                <p>
                    Wenn du uns per E-Mail oder über ein Kontaktformular
                    schreibst, verarbeiten wir deine Kontaktdaten und den Inhalt
                    der Nachricht, um die Anfrage zu bearbeiten. Rechtsgrundlage
                    ist Art. 6 Abs. 1 lit. b DSGVO bei vertragsbezogenen
                    Anfragen, im Übrigen Art. 6 Abs. 1 lit. f DSGVO. Die
                    Nachrichten werden gelöscht, sobald der Vorgang
                    abgeschlossen ist und keine gesetzlichen
                    Aufbewahrungsfristen entgegenstehen.
                </p>
            </LegalSection>

            <LegalSection label="05" title="Kundenkonto und Vertragsabwicklung">
                <p>
                    Für den Kundenbereich verarbeiten wir die dafür
                    erforderlichen Bestands- und Vertragsdaten: Name, optional
                    Firma, Anschrift, E-Mail-Adresse, optional
                    Umsatzsteuer-Identifikationsnummer und Telefonnummer, das
                    Passwort ausschließlich als kryptografischen Hash, sowie
                    Vertragsgegenstand, Laufzeit, Angebote und Rechnungen.
                </p>
                <p>
                    Aktivierst du die Zwei-Faktor-Authentifizierung, speichern
                    wir zusätzlich das dafür nötige Geheimnis und deine
                    Wiederherstellungscodes. Zur Abwehr automatisierter
                    Anmeldeversuche halten wir außerdem kurzzeitig Zähler vor,
                    die an die anfragende IP-Adresse gebunden sind (Art. 6 Abs.
                    1 lit. f DSGVO).
                </p>
                <p>
                    Zweck ist die Begründung, Durchführung und Beendigung des
                    Vertragsverhältnisses einschließlich Abrechnung und Support.
                    Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO. Soweit wir
                    Nutzungsdaten zur Missbrauchserkennung und Systemsicherheit
                    auswerten, ist Rechtsgrundlage Art. 6 Abs. 1 lit. f DSGVO.
                </p>
                <p>
                    Nach Vertragsende werden die Daten gelöscht, sobald sie für
                    die Zwecke nicht mehr erforderlich sind und keine
                    gesetzlichen Aufbewahrungspflichten bestehen.
                </p>
            </LegalSection>

            <LegalSection label="06" title="Angebote und Rechnungen">
                <p>
                    Angebote und Rechnungen erstellen wir aus deinen Stammdaten
                    und stellen sie dir im Kundenbereich sowie per E-Mail
                    bereit. Rechnungen versenden wir zusätzlich im Format
                    XRechnung, damit du sie maschinell weiterverarbeiten kannst.
                    Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO
                    (Vertragsdurchführung) sowie Art. 6 Abs. 1 lit. c DSGVO
                    (Rechnungsstellung nach § 14 UStG).
                </p>

                <p>
                    Eine ausgestellte Rechnung ist unveränderlich; Korrekturen
                    erfolgen durch Stornierung und Neuausstellung. Name und
                    Anschrift werden zum Zeitpunkt der Ausstellung in das
                    Dokument übernommen und bleiben dort erhalten, auch wenn du
                    deine Stammdaten später änderst — andernfalls würde ein
                    bereits erteilter Beleg nachträglich verändert.
                </p>
            </LegalSection>

            <LegalSection label="07" title="Zahlungsabwicklung">
                <p>
                    Rechnungen kannst du per Überweisung begleichen oder über
                    einen Zahlungsdienstleister bezahlen. Für die Kartenzahlung
                    setzen wir Stripe Payments Europe, Ltd., Dublin, Irland ein,
                    für die Zahlung mit einem PayPal-Konto PayPal (Europe) S.à
                    r.l. et Cie, S.C.A., Luxemburg. Der Zahlungsvorgang findet
                    auf einer Seite des jeweiligen Anbieters statt; von unserer
                    Seite wirst du dorthin weitergeleitet und anschließend
                    zurückgeführt. Bei einer Überweisung ist kein
                    Zahlungsdienstleister beteiligt.
                </p>
                <p>
                    An Stripe übermitteln wir deinen Namen, deine
                    E-Mail-Adresse, den Rechnungsbetrag, die Rechnungsnummer
                    sowie die internen Kennungen deines Kundenkontos und der
                    Rechnung. An PayPal übermitteln wir den Rechnungsbetrag, die
                    Rechnungsnummer und die interne Kennung der Rechnung.
                </p>
                <p>
                    Hinterlegst du ein Zahlungsmittel, übermitteln wir
                    zusätzlich die interne Kennung deines Kundenkontos und —
                    sofern du den Einzug für einen Vertrag einrichtest — die
                    Kennung dieses Vertrags, damit die spätere Abbuchung der
                    richtigen Rechnung zugeordnet werden kann.
                </p>
                <p>
                    Deine Zahlungsdaten erhalten wir nicht: Kartennummer,
                    Kartenprüfnummer, IBAN und deine PayPal-Zugangsdaten gibst
                    du ausschließlich beim Zahlungsdienstleister ein. Sie
                    erreichen unsere Server zu keinem Zeitpunkt.
                </p>
                <p>
                    Zurück erhalten und speichern wir eine Kennung deines
                    Kundenkontos beim Zahlungsdienstleister, die Referenz der
                    Zahlung, den Betrag, das vom Anbieter einbehaltene Entgelt,
                    den Status der Zahlung und den Zeitpunkt. Scheitert eine
                    Zahlung, speichern wir zusätzlich den vom Anbieter
                    gemeldeten Fehlergrund.
                </p>
                <p>
                    Hinterlegst du für einen Vertrag ein Zahlungsmittel, damit
                    Rechnungen daraus automatisch eingezogen werden, speichern
                    wir außerdem einen Token — eine Zeichenfolge, mit der wir
                    beim Zahlungsdienstleister einen Einzug auslösen können,
                    ohne die Zahlungsdaten selbst zu kennen — sowie eine
                    Bezeichnung zur Anzeige, etwa „VISA •••• 4242“ oder die bei
                    PayPal hinterlegte E-Mail-Adresse. Widerrufst du die
                    Autorisierung im Kundenbereich, verwenden wir den Token ab
                    sofort nicht mehr und beauftragen den Zahlungsdienstleister
                    mit seiner Löschung.
                </p>
                <p>
                    Rechtsgrundlage für die Verarbeitung durch uns ist Art. 6
                    Abs. 1 lit. b DSGVO (Durchführung des Vertrags). Soweit die
                    Zahlungsdienstleister die Daten darüber hinaus zur
                    Betrugsprävention verarbeiten, stützen sie das auf Art. 6
                    Abs. 1 lit. f DSGVO. Für den Zahlungsvorgang sind sie eigene
                    Verantwortliche und nicht unsere Auftragsverarbeiter;
                    Näheres steht im Abschnitt „Empfänger“. Es gelten ihre
                    eigenen Datenschutzhinweise:{" "}
                    <a
                        href="https://stripe.com/de/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClass}
                    >
                        stripe.com/de/privacy
                    </a>{" "}
                    und{" "}
                    <a
                        href="https://www.paypal.com/de/legalhub/privacy-full"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClass}
                    >
                        paypal.com/de/legalhub/privacy-full
                    </a>
                    .
                </p>
                <p>
                    Zahlungen sind Buchungsbelege. Die dazu gespeicherten Daten
                    bewahren wir daher gemeinsam mit der zugehörigen Rechnung
                    für die Dauer der handels- und steuerrechtlichen
                    Aufbewahrungsfristen auf (§ 257 HGB, § 147 AO) und
                    beschränken für diese Zeit die Verarbeitung.
                </p>
            </LegalSection>

            <LegalSection
                label="08"
                title="Cookies und vergleichbare Techniken"
            >
                <p>
                    Für den Aufruf dieser Internetseite werden keine Cookies
                    gesetzt und keine Informationen auf deinem Endgerät
                    gespeichert oder ausgelesen. Es kommen keine Verfahren zur
                    Wiedererkennung von Besuchern und kein Fingerprinting zum
                    Einsatz.
                </p>
                <p>
                    Soweit ein Kundenbereich bereitgestellt wird, werden dort
                    ausschließlich technisch notwendige Cookies zur
                    Sitzungsverwaltung und zum Schutz vor
                    Cross-Site-Request-Forgery eingesetzt. Diese sind für den
                    von dir ausdrücklich gewünschten Dienst unbedingt
                    erforderlich; eine Einwilligung ist dafür nach § 25 Abs. 2
                    Nr. 2 TDDDG nicht erforderlich. Rechtsgrundlage der
                    anschließenden Verarbeitung ist Art. 6 Abs. 1 lit. b DSGVO.
                </p>
                <p>Ein Cookie-Banner wird deshalb nicht angezeigt.</p>
            </LegalSection>

            <LegalSection
                label="09"
                title="Keine Analyse, keine Einbindung Dritter"
            >
                <p>
                    Es findet keine Webanalyse und keine Reichweitenmessung
                    statt. Es sind keine Tracking-Dienste, Werbenetzwerke,
                    Social-Media-Plugins, Kartendienste, Video-Einbettungen oder
                    externen Content-Delivery-Networks eingebunden.
                    Schriftarten, Skripte und Stylesheets werden ausschließlich
                    von unserem eigenen Server ausgeliefert.
                </p>
            </LegalSection>

            <LegalSection label="10" title="Externe Verlinkungen">
                <p>
                    Unsere Seiten können Verweise auf Websites Dritter
                    enthalten. Solche Verweise werden ausschließlich als reine
                    Links eingebunden; Inhalte Dritter werden nicht eingebettet.
                    Eine Verbindung zum jeweiligen Anbieter entsteht erst, wenn
                    du einen solchen Link aktiv anklickst. Dabei wird deine
                    IP-Adresse an den Anbieter der Zielseite übertragen. Auf die
                    dortige Verarbeitung haben wir keinen Einfluss; es gelten
                    die Datenschutzhinweise des jeweiligen Anbieters.
                </p>
            </LegalSection>

            <LegalSection
                label="11"
                title="Daten auf den von dir genutzten Instanzen"
            >
                <p>
                    Für personenbezogene Daten, die du auf einer von uns
                    bereitgestellten Instanz speicherst oder verarbeitest, bist
                    du Verantwortlicher im Sinne des Art. 4 Nr. 7 DSGVO. Wir
                    werden insoweit als Auftragsverarbeiter tätig und
                    verarbeiten diese Daten ausschließlich nach deinen
                    Weisungen. Vor Beginn einer solchen Verarbeitung schließen
                    wir mit dir einen Auftragsverarbeitungsvertrag nach Art. 28
                    DSGVO.
                </p>
                <p>
                    Dir obliegt es, für die auf der Instanz verarbeiteten Daten
                    die eigenen datenschutzrechtlichen Pflichten zu erfüllen,
                    insbesondere Informationspflichten, Einwilligungen und
                    Betroffenenrechte.
                </p>
            </LegalSection>

            <LegalSection label="12" title="Empfänger">
                <p>
                    Personenbezogene Daten werden nicht verkauft, nicht
                    vermietet und nicht zu Werbezwecken an Dritte weitergegeben.
                    Eine Offenlegung erfolgt nur, soweit wir gesetzlich dazu
                    verpflichtet sind, soweit dies zur Durchführung des Vertrags
                    erforderlich ist oder soweit du eingewilligt hast.
                </p>
                <p>
                    Soweit wir Dienstleister einsetzen, die personenbezogene
                    Daten ausschließlich nach unseren Weisungen verarbeiten —
                    etwa für den E-Mail-Versand oder Rechenzentrumsleistungen —,
                    geschieht dies auf Grundlage eines
                    Auftragsverarbeitungsvertrags nach Art. 28 DSGVO.
                </p>
                <p>
                    Für die Zahlungsabwicklung gilt das nicht. Stripe Payments
                    Europe, Ltd., Dublin, Irland, und PayPal (Europe) S.à r.l.
                    et Cie, S.C.A., Luxemburg, entscheiden über Zwecke und
                    Mittel der Verarbeitung des Zahlungsvorgangs selbst — unter
                    anderem, weil sie eigene aufsichtsrechtliche Pflichten
                    erfüllen und Betrug verhindern müssen. Sie sind insoweit
                    eigene Verantwortliche im Sinne des Art. 4 Nr. 7 DSGVO und
                    nicht unsere Auftragsverarbeiter; für ihre Verarbeitung
                    gelten ihre eigenen Datenschutzhinweise. Welche Daten wir
                    ihnen übermitteln, steht im Abschnitt „Zahlungsabwicklung“.
                </p>
            </LegalSection>

            <LegalSection label="13" title="Drittlandübermittlung">
                <p>
                    Wir selbst übermitteln keine personenbezogenen Daten in
                    Länder außerhalb der Europäischen Union oder des
                    Europäischen Wirtschaftsraums.
                </p>
                <p>
                    Unsere Zahlungsdienstleister sitzen in Irland und Luxemburg,
                    geben Daten aber an Konzerngesellschaften außerhalb des
                    Europäischen Wirtschaftsraums weiter. Diese Übermittlungen
                    stützen beide auf die Standardvertragsklauseln der
                    Europäischen Kommission (Art. 46 Abs. 2 lit. c DSGVO).
                    Einzelheiten stehen in ihren Datenschutzhinweisen.
                </p>
            </LegalSection>

            <LegalSection label="14" title="Speicherdauer">
                <p>
                    Wir speichern personenbezogene Daten nur so lange, wie es
                    für die jeweiligen Zwecke erforderlich ist. Danach werden
                    sie gelöscht, sofern keine gesetzlichen
                    Aufbewahrungspflichten entgegenstehen. Handels- und
                    steuerrechtliche Aufbewahrungsfristen betragen insbesondere
                    sechs Jahre nach § 257 HGB und zehn Jahre nach § 147 AO; für
                    die Dauer dieser Fristen wird die Verarbeitung
                    eingeschränkt.
                </p>
            </LegalSection>

            <LegalSection
                label="15"
                title="Automatisierte Entscheidungsfindung"
            >
                <p>
                    Eine automatisierte Entscheidungsfindung einschließlich
                    Profiling nach Art. 22 DSGVO findet nicht statt.
                </p>
            </LegalSection>

            <LegalSection label="16" title="Deine Rechte">
                <p>Dir stehen uns gegenüber folgende Rechte zu:</p>
                <LegalList
                    items={[
                        "Auskunft über die zu deiner Person verarbeiteten Daten (Art. 15 DSGVO)",
                        "Berichtigung unrichtiger oder Vervollständigung unvollständiger Daten (Art. 16 DSGVO)",
                        "Löschung (Art. 17 DSGVO)",
                        "Einschränkung der Verarbeitung (Art. 18 DSGVO)",
                        "Datenübertragbarkeit (Art. 20 DSGVO)",
                        "Widerspruch gegen Verarbeitungen auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO (Art. 21 DSGVO)",
                        "Widerruf einer erteilten Einwilligung mit Wirkung für die Zukunft (Art. 7 Abs. 3 DSGVO)",
                    ]}
                />
                <p>
                    Zur Ausübung genügt eine formlose Nachricht an{" "}
                    <a href={`mailto:${operator.email}`} className={linkClass}>
                        {operator.email}
                    </a>
                    .
                </p>
            </LegalSection>

            <LegalSection label="17" title="Beschwerderecht">
                <p>
                    Unbeschadet anderweitiger Rechtsbehelfe steht dir ein
                    Beschwerderecht bei einer Datenschutz-Aufsichtsbehörde zu
                    (Art. 77 DSGVO). Für uns zuständig ist die Landesbeauftragte
                    für Datenschutz und Informationsfreiheit Nordrhein-Westfalen
                    in Düsseldorf (
                    <a
                        href="https://www.ldi.nrw.de"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClass}
                    >
                        ldi.nrw.de
                    </a>
                    ). Du kannst dich auch an die Aufsichtsbehörde deines
                    gewöhnlichen Aufenthaltsorts wenden.
                </p>
            </LegalSection>

            <LegalSection label="18" title="Änderungen dieser Erklärung">
                <p>
                    Wir passen diese Datenschutzerklärung an, sobald sich die
                    beschriebenen Verarbeitungen ändern — insbesondere mit dem
                    Start des Kundenbereichs. Es gilt jeweils die hier
                    veröffentlichte Fassung.
                </p>
            </LegalSection>
        </LegalPage>
    );
}
