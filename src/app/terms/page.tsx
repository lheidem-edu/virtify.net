import type { Metadata } from "next";
import Link from "next/link";
import LegalList from "@/lib/components/legal/legal-list";
import LegalPage from "@/lib/components/legal/legal-page";
import LegalSection from "@/lib/components/legal/legal-section";
import { operator, policy, site } from "@/lib/site";

export const metadata: Metadata = {
    title: "Allgemeine Geschäftsbedingungen",
    description: `Allgemeine Geschäftsbedingungen für die Bereitstellung von KVM-Instanzen durch ${operator.name} (${site.name}).`,
};

const linkClass =
    "text-white underline decoration-zinc-600 underline-offset-4 transition-colors hover:decoration-white";

export default function Page() {
    return (
        <LegalPage
            title="Allgemeine Geschäftsbedingungen"
            intro={
                <>
                    <p>
                        Diese Bedingungen gelten für die Bereitstellung und den
                        Betrieb von KVM-Instanzen durch {operator.name} (
                        {site.name}). Sie ergänzen den jeweils geschlossenen
                        Einzelvertrag; abweichende Regelungen darin gehen vor.
                    </p>
                    <p className="mt-4">
                        Die bloße Nutzung dieser Website begründet weder ein
                        Vertragsverhältnis noch eine Zahlungspflicht.
                    </p>
                </>
            }
        >
            <LegalSection label="§ 1" title="Geltungsbereich und Begriffe">
                <LegalList
                    variant="paren"
                    items={[
                        <>
                            Diese Allgemeinen Geschäftsbedingungen gelten für
                            alle Verträge über die Bereitstellung und den
                            Betrieb informationstechnischer Infrastruktur in
                            Form von KVM-Instanzen (virtuellen Maschinen) sowie
                            damit verbundene Leistungen zwischen {operator.name}
                            , {operator.street}, {operator.city},{" "}
                            {operator.country}, handelnd unter {site.name}{" "}
                            (nachfolgend „Anbieter“), und dem Kunden.
                        </>,
                        <>
                            Der Anbieter ist unter{" "}
                            <a
                                href={`mailto:${operator.email}`}
                                className={linkClass}
                            >
                                {operator.email}
                            </a>{" "}
                            erreichbar. Diese Adresse ist zugleich Kontaktstelle
                            nach Art. 11 und 12 der Verordnung (EU) 2022/2065
                            sowie nach Art. 15 der Verordnung (EU) 2021/784. Die
                            Kommunikation erfolgt in deutscher oder englischer
                            Sprache.
                        </>,
                        "Abweichende, entgegenstehende oder ergänzende Bedingungen des Kunden werden nicht Vertragsbestandteil, es sei denn, der Anbieter stimmt ihrer Geltung ausdrücklich in Textform zu.",
                        "Individuelle Vereinbarungen im Einzelvertrag gehen diesen Bedingungen vor (§ 305b BGB). Leistungsumfang, Vergütung und Laufzeit ergeben sich aus dem jeweiligen Angebot.",
                        "Verbraucher ist jede natürliche Person, die ein Rechtsgeschäft zu Zwecken abschließt, die überwiegend weder ihrer gewerblichen noch ihrer selbständigen beruflichen Tätigkeit zugerechnet werden können (§ 13 BGB). Unternehmer ist eine natürliche oder juristische Person oder eine rechtsfähige Personengesellschaft, die bei Abschluss des Vertrags in Ausübung ihrer gewerblichen oder selbständigen beruflichen Tätigkeit handelt (§ 14 BGB).",
                        "Werktage sind Montag bis Freitag mit Ausnahme der gesetzlichen Feiertage am Sitz des Anbieters.",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 2"
                title="Vertragsgegenstand und Leistungsumfang"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Der Anbieter stellt dem Kunden die im Einzelvertrag bezeichneten KVM-Instanzen bereit und betreibt die zugrunde liegende Infrastruktur für die Vertragsdauer. Die Instanzen werden dem Kunden mit ausschließlichem Nutzungsrecht überlassen.",
                        "Die wesentlichen Merkmale der Leistung ergeben sich aus der Leistungsbeschreibung des jeweiligen Angebots.",
                        "Sämtliche Komponenten der eingesetzten Infrastruktur verbleiben vollumfänglich im Eigentum beziehungsweise in der Verfügungsgewalt des Anbieters. Ein Eigentumsübergang findet nicht statt.",
                        "Die Komponenten werden in betriebsbereitem Zustand bereitgestellt. Der Anbieter ist für den Austausch defekter Komponenten verantwortlich.",
                        "Zugewiesene IP-Adressen und Adressbereiche werden dem Kunden nur für die Vertragsdauer zur Nutzung überlassen. Ein Anspruch darauf, dass der Instanz dieselbe Adresse für die gesamte Vertragslaufzeit zugewiesen bleibt, besteht nicht; der Anbieter behält sich vor, zugewiesene Adressen bei technischer oder rechtlicher Notwendigkeit zu ändern. Ein Anspruch auf Übertragung oder Mitnahme besteht nicht.",
                        "Der Anbieter ist berechtigt, die eingesetzte Hard- und Software an den jeweiligen Stand der Technik anzupassen, soweit der vertraglich geschuldete Leistungsumfang dadurch nicht eingeschränkt wird und die Anpassung für den Kunden zumutbar ist. Ergeben sich hieraus zusätzliche Anforderungen an die vom Kunden betriebenen Systeme, teilt der Anbieter dies rechtzeitig mit.",
                        "Soweit der Anbieter Software bereitstellt, erhält der Kunde für die Vertragsdauer ein einfaches, nicht übertragbares Nutzungsrecht. Die Lizenzbedingungen der jeweiligen Hersteller sind einzuhalten.",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 3"
                title="Vertragsschluss, Vertragssprache und Vertragstext"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Die Darstellung der Leistungen stellt kein bindendes Angebot dar, sondern eine Aufforderung an den Kunden, ein Angebot abzugeben.",
                        "Mit dem Absenden einer Bestellung gibt der Kunde ein verbindliches Angebot ab. Der Anbieter kann dieses innerhalb von fünf Tagen durch eine Bestätigung in Textform oder durch die Bereitstellung der Leistung annehmen.",
                        "Vor dem Absenden der Bestellung kann der Kunde sämtliche Angaben prüfen, ändern oder die Bestellung abbrechen.",
                        "Anfragen des Kunden zur Erstellung eines individuellen Angebots sind unverbindlich. Der Anbieter unterbreitet hierzu ein Angebot in Textform, das der Kunde innerhalb von fünf Tagen annehmen kann, soweit im Angebot keine andere Frist ausgewiesen ist.",
                        "Vertragssprache ist Deutsch.",
                        "Der Anbieter speichert den Vertragstext nicht in einer für den Kunden abrufbaren Form. Vor dem Absenden der Bestellung kann der Kunde die Vertragsdaten ausdrucken oder elektronisch sichern. Nach Zugang der Bestellung übersendet der Anbieter die Bestelldaten, die gesetzlich vorgeschriebenen Informationen bei Fernabsatzverträgen sowie diese Bedingungen erneut per E-Mail.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 4" title="Kundenkonto">
                <LegalList
                    variant="paren"
                    items={[
                        "Für die Buchung und Verwaltung der Leistungen kann ein Kundenkonto erforderlich sein. Die Einrichtung ist unentgeltlich und begründet für sich genommen keine Zahlungspflicht.",
                        "Der Kunde hält die bei der Registrierung angegebenen Daten zutreffend und aktuell und informiert den Anbieter unverzüglich über Änderungen der für die Vertragsdurchführung erforderlichen Daten.",
                        "Die Abwicklung und die Übermittlung der im Zusammenhang mit dem Vertragsschluss erforderlichen Informationen erfolgen ganz oder teilweise automatisiert per E-Mail. Der Kunde stellt sicher, dass die hinterlegte E-Mail-Adresse zutreffend ist und der Empfang technisch möglich ist, insbesondere nicht durch Spam-Filter verhindert wird.",
                        "Der Kunde kann die Löschung des Kundenkontos jederzeit verlangen, soweit keine laufenden Verträge oder offenen Forderungen entgegenstehen und keine gesetzlichen Aufbewahrungspflichten bestehen.",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 5"
                title="Bereitstellung und Service-Readiness"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Die Bereitstellung erfolgt, soweit nicht anders vereinbart, innerhalb eines Werktages nach Vertragsschluss; bei vereinbarter Vorauszahlung nach dem Zeitpunkt der Zahlungsanweisung des Kunden.",
                        "Service-Readiness ist erreicht, sobald der Kunde alle vertraglich vereinbarten Zugangsdaten erhalten hat und die Instanz erstmalig in betriebsbereitem Zustand für den Kunden erreichbar ist.",
                        "Mit Erreichen der Service-Readiness beginnen die Laufzeit und die Rechnungsstellung.",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 6"
                title="Zugriffs- und Verwaltungsbestimmungen"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Der Kunde erhält den im Einzelvertrag vereinbarten Zugang zur Instanz und zum Kundenbereich. Die Zugangsdaten stellt der Anbieter bereit.",
                        "Der Kunde hat Zugangsdaten geheim zu halten, vor dem Zugriff Dritter zu schützen und den Anbieter unverzüglich zu informieren, wenn Anhaltspunkte für eine missbräuchliche Nutzung bestehen.",
                        "Soweit im Einzelvertrag nichts anderes vereinbart ist, ist der Kunde nicht berechtigt, Konfiguration oder Zugangsdaten der vom Anbieter betriebenen Management-Ebenen zu ändern; dazu zählen insbesondere Host-Systeme, Hypervisor und Out-of-Band-Management. Der Zugang des Kunden beschränkt sich auf die ihm zugewiesene Instanz und den Kundenbereich.",
                        "Werden wegen eines Verstoßes gegen Absatz (3) manuelle Eingriffe erforderlich, kann der Anbieter den tatsächlich entstandenen Aufwand einschließlich Anfahrt, Arbeitszeit und Wiederherstellung nach dem im Einzelvertrag vereinbarten oder dem vorab mitgeteilten Stundensatz gesondert in Rechnung stellen. Dem Kunden bleibt der Nachweis vorbehalten, dass kein oder ein geringerer Aufwand entstanden ist.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 7" title="Vergütung und Zahlung">
                <LegalList
                    variant="paren"
                    items={[
                        "Der Anbieter ist Kleinunternehmer im Sinne des § 19 UStG. Sämtliche Preise enthalten daher keine Umsatzsteuer; Umsatzsteuer wird nicht ausgewiesen und nicht berechnet. Die angegebenen Preise sind Gesamtpreise und enthalten alle Preisbestandteile.",
                        "Die Höhe der Vergütung, inkludierte Kontingente und die verfügbaren Zahlungsarten ergeben sich aus dem jeweiligen Angebot.",
                        <>
                            Die Rechnungsstellung erfolgt, soweit nicht anders
                            vereinbart, im Voraus für den jeweiligen
                            Abrechnungszeitraum. Die Zahlung ist innerhalb von{" "}
                            {policy.paymentTermDays} Tagen nach Rechnungsdatum
                            ohne Abzug fällig.
                        </>,
                        "Sind im Einzelvertrag Transfervolumina oder vergleichbare Kontingente inkludiert, informiert der Anbieter den Kunden rechtzeitig vor deren Ausschöpfung. Überschreitungen werden zu den im Einzelvertrag vereinbarten Sätzen abgerechnet.",
                        "Bei Zahlungsverzug ist der Anbieter berechtigt, den Zugang zur Instanz nach erfolgloser Mahnung mit einer Frist von sieben Werktagen vorübergehend zu sperren. Während der Sperrung kann der Anbieter die vertraglichen Leistungen nicht erbringen. Gesetzliche Ansprüche auf Verzugszinsen und Ersatz von Mahnkosten bleiben unberührt.",
                        "Soweit nicht anders vereinbart, erfolgt die Zahlung bargeldlos auf das dem Kunden mitgeteilte Konto. Kosten der Geldübermittlung trägt der Kunde, soweit die Zahlung außerhalb der Europäischen Union veranlasst wurde.",
                        "Der Kunde kann nur mit unbestrittenen oder rechtskräftig festgestellten Forderungen aufrechnen. Ein Zurückbehaltungsrecht steht ihm nur wegen Ansprüchen aus demselben Vertragsverhältnis zu.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 8" title="Laufzeit und Kündigung">
                <LegalList
                    variant="paren"
                    items={[
                        "Der Vertrag wird mit Vertragsschluss wirksam. Er hat die im jeweiligen Angebot ausgewiesene Grundlaufzeit; eine Grundlaufzeit von mehr als zwölf Monaten wird nicht vereinbart. Ist keine Grundlaufzeit ausgewiesen, beträgt sie zwölf Monate ab Service-Readiness und endet zwölf Monate nach dem Ende des Monats, in dem die Service-Readiness erreicht wurde.",
                        "Wird der Vertrag nicht spätestens einen Monat vor Ablauf der Grundlaufzeit von einer der Vertragsparteien gekündigt, verlängert er sich auf unbestimmte Zeit. Das verlängerte Vertragsverhältnis kann von beiden Vertragsparteien jederzeit mit einer Frist von einem Monat gekündigt werden.",
                        "Das Recht zur außerordentlichen Kündigung aus wichtigem Grund bleibt unberührt. Ein wichtiger Grund liegt für den Anbieter insbesondere bei erheblichen oder wiederholten Verstößen gegen die §§ 10 bis 13 sowie bei Zahlungsverzug mit mehr als zwei Abrechnungszeiträumen vor.",
                        "Kündigungen bedürfen der Textform, etwa per E-Mail oder Ticket. Soweit der Anbieter im Kundenbereich eine Kündigungsschaltfläche bereitstellt, kann die Kündigung auch darüber erklärt werden.",
                        "Der Kunde ist verpflichtet, seine Daten vor Vertragsende zu sichern. Nach Vertragsende löscht der Anbieter die Instanz einschließlich der darauf gespeicherten Daten und räumt hierfür zuvor eine angemessene Frist zur Datensicherung ein, soweit dem keine rechtlichen Gründe entgegenstehen.",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 9"
                title="Betrieb, Wartung und Verfügbarkeit"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Der Anbieter betreibt die Infrastruktur mit der Sorgfalt eines ordentlichen Kaufmanns und beseitigt Störungen im Rahmen seiner betrieblichen Möglichkeiten.",
                        "Eine bestimmte Verfügbarkeit wird nicht allgemein zugesagt. Ein Service Level Agreement kommt nur zustande, soweit es im jeweiligen Angebot ausdrücklich ausgewiesen ist; Zusagewert, Messverfahren und etwaige Gutschriften richten sich dann ausschließlich danach.",
                        "Maßgeblicher Übergabepunkt für eine vereinbarte Verfügbarkeitsmessung ist, soweit nicht anders vereinbart, der Ausgang des vom Anbieter betriebenen Netzes.",
                        "Geplante Wartungsarbeiten werden dem Kunden mindestens sieben Werktage im Voraus in Textform mitgeteilt und gelten nicht als Ausfallzeit. Unaufschiebbare Maßnahmen zur Abwehr akuter Gefahren für den Betrieb, die Sicherheit oder Dritte kann der Anbieter ohne Vorankündigung durchführen.",
                        <>
                            Nicht als Ausfallzeit gelten ferner Zeiten, in denen
                            die Instanz aus Gründen außerhalb des
                            Einflussbereichs des Anbieters nicht erreichbar ist,
                            insbesondere höhere Gewalt, Störungen bei Providern
                            außerhalb des vom Anbieter betriebenen Netzes,
                            Ausfälle der Basisinfrastruktur des Rechenzentrums,
                            Distributed-Denial-of-Service-Angriffe sowie vom
                            Kunden verursachte Fehlfunktionen oder
                            Konfigurationsfehler.
                        </>,
                        "Störungen sind dem Anbieter unverzüglich in Textform anzuzeigen.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 10" title="Nutzungsbestimmungen">
                <LegalList
                    variant="paren"
                    items={[
                        "Der Kunde verpflichtet sich zur ausschließlich rechtmäßigen Nutzung der bereitgestellten Leistungen unter Beachtung sämtlicher geltender Rechtsvorschriften.",
                        <>
                            Untersagt sind insbesondere:
                            <LegalList
                                items={[
                                    "rechtswidrige Handlungen jeglicher Art,",
                                    "der Versand unerwünschter elektronischer Nachrichten sowie der Betrieb offener Mail-Relays oder vergleichbarer Systeme,",
                                    "Denial-of-Service-Angriffe und sonstige Handlungen, die geeignet sind, Netze, Systeme oder Daten Dritter zu beeinträchtigen oder zu gefährden,",
                                    "das Mining von Kryptowährungen oder vergleichbare rechenintensive Operationen ohne vorherige Absprache,",
                                    "Verstöße gegen die Nutzungsbedingungen oder Richtlinien der eingesetzten Netz- und Rechenzentrumsbetreiber,",
                                    "die Verbreitung urheberrechtlich geschützten Materials ohne entsprechende Lizenz, insbesondere über Torrent- oder Filesharing-Dienste.",
                                ]}
                            />
                        </>,
                        "Bei einem Verstoß ist der Anbieter berechtigt, die Instanz zu sperren oder vom Netz zu trennen und den Vertrag außerordentlich fristlos zu kündigen. Die Maßnahme wird auf das Erforderliche beschränkt und, soweit möglich, vorher angekündigt; bei drohender Gefahr für das Netz, die Systeme des Anbieters oder Dritte kann sie ohne Vorankündigung erfolgen. Der Kunde wird unverzüglich informiert.",
                        "Im Fall einer vom Kunden zu vertretenden außerordentlichen Kündigung bleibt der Vergütungsanspruch des Anbieters für den laufenden Abrechnungszeitraum bestehen. Dem Kunden bleibt der Nachweis vorbehalten, dass kein oder ein geringerer Schaden entstanden ist. Weitergehende gesetzliche Ansprüche bleiben unberührt.",
                        "Eine allgemeine Pflicht, die vom Kunden gespeicherten Inhalte zu überwachen oder aktiv nach rechtswidrigen Inhalten zu suchen, trifft den Anbieter nicht (§§ 7 ff. DDG, Art. 8 der Verordnung (EU) 2022/2065).",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 11"
                title="Pflichten des Kunden und Datensicherung"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Für die auf der Instanz betriebenen Systeme, die dort eingesetzte Software und die dort gespeicherten Inhalte ist der Kunde allein verantwortlich.",
                        "Soweit der Kunde administrative Rechte auf der Instanz erhält, obliegen ihm deren Verwaltung und Absicherung. Er hält die eingesetzte Software aktuell, informiert sich über bekannt werdende Sicherheitslücken und schließt diese selbständig. Vom Anbieter bereitgestellte oder empfohlene Werkzeuge entbinden ihn hiervon nicht.",
                        "Der Kunde richtet seine Instanz so ein und verwaltet sie so, dass die Sicherheit, Integrität und Verfügbarkeit der Systeme und des Netzes des Anbieters sowie der Systeme, Netze und Daten Dritter nicht gefährdet werden.",
                        "Die Datensicherung obliegt dem Kunden, soweit im Einzelvertrag keine Sicherungsleistung ausgewiesen ist. Im Fall eines Datenverlusts überträgt der Kunde die betreffenden Datenbestände erneut auf die Instanz.",
                        "Missbrauchsmeldungen beantwortet der Kunde unverzüglich.",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 12"
                title="Verbreitung terroristischer Inhalte"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Die Verbreitung terroristischer Inhalte unter Nutzung der Dienste des Anbieters ist untersagt.",
                        "Terroristische Inhalte sind Materialien im Sinne des Art. 2 Nr. 7 der Verordnung (EU) 2021/784 (TCO-VO), insbesondere Materialien, die zur Begehung terroristischer Straftaten anstiften, dazu bestimmen oder anleiten, zur Beteiligung an einer terroristischen Vereinigung bestimmen oder die Begehung einer solchen Straftat androhen.",
                        <>
                            Meldungen über mutmaßlich terroristische Inhalte
                            sind elektronisch an die Kontaktstelle des Anbieters
                            zu richten:{" "}
                            <a
                                href={`mailto:${operator.email}`}
                                className={linkClass}
                            >
                                {operator.email}
                            </a>
                            .
                        </>,
                        "Eine Entfernungsanordnung der zuständigen Behörde setzt der Anbieter spätestens innerhalb einer Stunde nach Erhalt um, sofern die Anordnung keine offensichtlichen Fehler und keine unzureichenden Informationen enthält. Anschließend informiert er die Behörde und den Kunden unverzüglich über die getroffenen Maßnahmen.",
                        "Liegt keine behördliche Entfernungsanordnung vor, prüft der Anbieter die gemeldeten Inhalte. Bestätigt sich die öffentliche Verbreitung terroristischer Inhalte, ergreift er nach pflichtgemäßem Ermessen Maßnahmen, um die Verbreitung schnellstmöglich zu unterbinden; hierzu zählen insbesondere die Entfernung oder Sperrung der Inhalte, die Sperrung der Instanz, die Sperrung des Kundenkontos sowie die Verhinderung des Zugriffs auf die Dienste.",
                        "Gegen die getroffenen Maßnahmen kann der Kunde innerhalb eines Monats nach der Mitteilung Beschwerde einlegen. Die Beschwerde ist zu begründen und an die Kontaktstelle zu richten. Der Anbieter teilt das Ergebnis seiner Prüfung innerhalb von zwei Wochen nach Eingang der Beschwerde mit. Erweist sich eine Maßnahme als unberechtigt, wird sie aufgehoben und die betroffenen Inhalte werden wiederhergestellt.",
                    ]}
                />
            </LegalSection>

            <LegalSection
                label="§ 13"
                title="Umgang mit rechtswidrigen Inhalten"
            >
                <LegalList
                    variant="paren"
                    items={[
                        "Die Veröffentlichung rechtswidriger Inhalte unter Nutzung der Dienste des Anbieters ist untersagt. Für die über die Instanz veröffentlichten oder in sonstiger Weise zugänglich gemachten Inhalte ist der Kunde allein verantwortlich.",
                        <>
                            Rechtswidrig sind insbesondere Inhalte, die
                            <LegalList
                                items={[
                                    "gegen Urheber-, Marken- oder Wettbewerbsrecht verstoßen,",
                                    "den Tatbestand einer Straftat oder einer Ordnungswidrigkeit erfüllen,",
                                    "gegen datenschutzrechtliche Vorschriften oder die Pflicht zur Anbieterkennzeichnung verstoßen,",
                                    "rassistisch, diskriminierend, beleidigend oder gewaltverherrlichend sind oder in sonstiger Weise Persönlichkeitsrechte oder andere Grundrechte verletzen,",
                                    "jugendgefährdend sind.",
                                ]}
                            />
                        </>,
                        <>
                            Der Kunde und Dritte können mutmaßlich rechtswidrige
                            Inhalte jederzeit elektronisch an die Kontaktstelle
                            des Anbieters nach Art. 11 und 12 der Verordnung
                            (EU) 2022/2065 melden:{" "}
                            <a
                                href={`mailto:${operator.email}`}
                                className={linkClass}
                            >
                                {operator.email}
                            </a>
                            . Die Meldung soll die beanstandeten Inhalte
                            hinreichend genau bezeichnen und begründen.
                        </>,
                        "Der Anbieter prüft eingehende Meldungen sorgfältig, objektiv und verhältnismäßig. Die Prüfung wird von Menschen vorgenommen; automatisierte Mittel werden allenfalls unterstützend eingesetzt.",
                        "Bestätigt sich die Rechtswidrigkeit, ergreift der Anbieter nach pflichtgemäßem Ermessen Maßnahmen: Entfernung oder Sperrung der betroffenen Inhalte, Sperrung der Instanz, Sperrung des Kundenkontos, Verhinderung des Zugriffs auf die Dienste oder Kündigung des Vertragsverhältnisses. Dabei berücksichtigt er die Rechte und berechtigten Interessen aller Beteiligten, insbesondere die Freiheit der Meinungsäußerung.",
                        "Über eine Maßnahme nach Absatz (5) informiert der Anbieter den Kunden und legt eine Begründung nach Art. 17 der Verordnung (EU) 2022/2065 vor.",
                        "Gegen eine Maßnahme nach Absatz (5) kann der Kunde innerhalb eines Monats nach Zugang der Begründung Beschwerde einlegen. Die Beschwerde ist zu begründen und an die Kontaktstelle zu richten. Der Anbieter teilt das Ergebnis innerhalb von zwei Wochen nach Eingang mit und hebt unberechtigte Maßnahmen auf.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 14" title="Mängelhaftung und Haftung">
                <LegalList
                    variant="paren"
                    items={[
                        "Es bestehen die gesetzlichen Mängelhaftungsrechte.",
                        "Der Anbieter haftet unbeschränkt bei Vorsatz und grober Fahrlässigkeit, bei der Verletzung des Lebens, des Körpers oder der Gesundheit, im Umfang einer übernommenen Garantie sowie nach dem Produkthaftungsgesetz.",
                        "Bei einfacher Fahrlässigkeit haftet der Anbieter nur bei der Verletzung wesentlicher Vertragspflichten (Kardinalpflichten) und der Höhe nach begrenzt auf den vorhersehbaren, vertragstypischen Schaden. Wesentliche Vertragspflichten sind solche, deren Erfüllung die ordnungsgemäße Durchführung des Vertrags überhaupt erst ermöglicht und auf deren Einhaltung der Kunde regelmäßig vertrauen darf.",
                        "Eine Haftung für mittelbare Schäden und entgangenen Gewinn ist bei einfacher Fahrlässigkeit ausgeschlossen.",
                        "Die Haftung für Datenverlust ist auf den Wiederherstellungsaufwand beschränkt, der bei ordnungsgemäßer und regelmäßiger Datensicherung durch den Kunden angefallen wäre. Die Absätze (2) und (3) bleiben unberührt.",
                        "Die verschuldensunabhängige Haftung für bei Vertragsschluss vorhandene Mängel nach § 536a Abs. 1 Alt. 1 BGB ist ausgeschlossen.",
                        "Die vorstehenden Haftungsbeschränkungen gelten auch zugunsten der gesetzlichen Vertreter und Erfüllungsgehilfen des Anbieters.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 15" title="Freistellung">
                <p>
                    Der Kunde stellt den Anbieter von Ansprüchen Dritter frei,
                    die auf einer rechtswidrigen Nutzung der Leistungen durch
                    den Kunden oder auf den von ihm gespeicherten Inhalten
                    beruhen, einschließlich der angemessenen Kosten der
                    Rechtsverteidigung. Der Kunde unterstützt den Anbieter bei
                    der Abwehr solcher Ansprüche. Dies gilt nicht, soweit der
                    Kunde die Rechtsverletzung nicht zu vertreten hat.
                </p>
            </LegalSection>

            <LegalSection label="§ 16" title="Datenschutz und Vertraulichkeit">
                <LegalList
                    variant="paren"
                    items={[
                        "Der Anbieter hält die Bestimmungen der Datenschutz-Grundverordnung sowie sämtliche anwendbaren nationalen Datenschutzvorschriften ein. Eine Weitergabe von Daten an Dritte erfolgt ausschließlich im gesetzlich vorgeschriebenen Umfang oder mit ausdrücklicher Zustimmung des Kunden.",
                        "Verarbeitet der Kunde auf der Instanz personenbezogene Daten, ist er hierfür Verantwortlicher im Sinne des Art. 4 Nr. 7 DSGVO. Vor Beginn einer solchen Verarbeitung wird ein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO geschlossen.",
                        "Der Kunde ist bei der Nutzung der Leistungen selbst für die Einhaltung datenschutzrechtlicher Bestimmungen verantwortlich, insbesondere für Datenschutzerklärungen, die Einholung von Einwilligungen und die Umsetzung von Betroffenenrechten.",
                        "Beide Vertragsparteien behandeln vertrauliche Informationen der jeweils anderen Partei vertraulich, auch über das Vertragsende hinaus.",
                        <>
                            Für die Verarbeitung beim Besuch dieser Website gilt
                            die{" "}
                            <Link href="/privacy" className={linkClass}>
                                Datenschutzerklärung
                            </Link>
                            .
                        </>,
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 17" title="Höhere Gewalt">
                <p>
                    Ereignisse höherer Gewalt, die der Anbieter nicht zu
                    vertreten hat — insbesondere Naturkatastrophen, Krieg,
                    Terrorakte, Streiks, behördliche Anordnungen sowie
                    großflächige Strom- oder Netzausfälle — befreien die
                    Vertragsparteien für ihre Dauer von den betroffenen
                    Leistungspflichten. Dauert ein solcher Zustand länger als
                    sechs Wochen an, kann jede Vertragspartei den Vertrag
                    außerordentlich kündigen.
                </p>
            </LegalSection>

            <LegalSection label="§ 18" title="Änderungen dieser Bedingungen">
                <LegalList
                    variant="paren"
                    items={[
                        "Der Anbieter kann diese Bedingungen mit Wirkung für die Zukunft ändern, soweit die Änderung durch eine Änderung der Rechtslage, durch höchstrichterliche Rechtsprechung oder durch technische Entwicklungen veranlasst ist und den Kunden nicht unangemessen benachteiligt.",
                        "Änderungen werden dem Kunden mindestens sechs Wochen vor dem geplanten Wirksamwerden in Textform mitgeteilt. Widerspricht der Kunde nicht innerhalb von sechs Wochen nach Zugang in Textform, gelten die Änderungen als angenommen; auf diese Wirkung wird in der Mitteilung gesondert hingewiesen. Widerspricht der Kunde, kann jede Vertragspartei den Vertrag zum geplanten Zeitpunkt des Wirksamwerdens kündigen.",
                        "Änderungen der Hauptleistungspflichten oder der vereinbarten Vergütung können auf diesem Weg nicht herbeigeführt werden.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 19" title="Widerrufsrecht für Verbraucher">
                <LegalList
                    variant="paren"
                    items={[
                        "Ist der Kunde Verbraucher im Sinne des § 13 BGB, steht ihm bei Fernabsatzverträgen ein gesetzliches Widerrufsrecht nach § 355 BGB zu. Der Widerruf kann innerhalb von 14 Tagen ab Vertragsschluss ohne Angabe von Gründen in Textform erklärt werden.",
                        "Im Fall eines wirksamen Widerrufs werden bereits geleistete Zahlungen erstattet. Hat der Verbraucher verlangt, dass die Dienstleistung während der Widerrufsfrist beginnt, hat er für die bis zum Widerruf erbrachten Leistungen einen angemessenen Wertersatz zu zahlen.",
                        "Das Widerrufsrecht erlischt nach § 356 Abs. 4 BGB, wenn der Anbieter die Dienstleistung vollständig erbracht hat und mit der Ausführung erst begonnen hat, nachdem der Verbraucher dazu seine ausdrückliche Zustimmung gegeben und gleichzeitig seine Kenntnis davon bestätigt hat, dass er sein Widerrufsrecht bei vollständiger Vertragserfüllung verliert. Vollständige Vertragserfüllung liegt vor, sobald die Service-Readiness nach § 5 Absatz (2) erreicht ist.",
                        "Unternehmern steht kein Widerrufsrecht zu.",
                    ]}
                />
            </LegalSection>

            <LegalSection label="§ 20" title="Widerrufsbelehrung">
                <p className="font-medium text-zinc-200">Widerrufsrecht</p>
                <p>
                    Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von
                    Gründen diesen Vertrag zu widerrufen. Die Widerrufsfrist
                    beträgt vierzehn Tage ab dem Tag des Vertragsabschlusses.
                </p>
                <p>
                    Um Ihr Widerrufsrecht auszuüben, müssen Sie uns (
                    {operator.name}, {operator.street}, {operator.city},{" "}
                    {operator.country}, E-Mail:{" "}
                    <a href={`mailto:${operator.email}`} className={linkClass}>
                        {operator.email}
                    </a>
                    ) mittels einer eindeutigen Erklärung, etwa per E-Mail oder
                    Ticket, über Ihren Entschluss, diesen Vertrag zu widerrufen,
                    informieren. Sie können dafür das{" "}
                    <a
                        href="/withdrawal-form"
                        target="_blank"
                        rel="noopener"
                        className={linkClass}
                    >
                        Muster-Widerrufsformular (PDF)
                    </a>{" "}
                    verwenden, das jedoch nicht vorgeschrieben ist.
                </p>
                <p>
                    Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die
                    Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf
                    der Widerrufsfrist absenden.
                </p>

                <p className="pt-2 font-medium text-zinc-200">
                    Folgen des Widerrufs
                </p>
                <p>
                    Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle
                    Zahlungen, die wir von Ihnen erhalten haben, unverzüglich
                    und spätestens binnen vierzehn Tagen ab dem Tag
                    zurückzuzahlen, an dem die Mitteilung über Ihren Widerruf
                    dieses Vertrags bei uns eingegangen ist. Für diese
                    Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie
                    bei der ursprünglichen Transaktion eingesetzt haben, es sei
                    denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart;
                    in keinem Fall werden Ihnen wegen dieser Rückzahlung
                    Entgelte berechnet.
                </p>
                <p>
                    Haben Sie verlangt, dass die Dienstleistung während der
                    Widerrufsfrist beginnen soll, so haben Sie uns einen
                    angemessenen Betrag zu zahlen, der dem Anteil der bis zu dem
                    Zeitpunkt, zu dem Sie uns von der Ausübung des
                    Widerrufsrechts hinsichtlich dieses Vertrags unterrichten,
                    bereits erbrachten Dienstleistungen im Vergleich zum
                    Gesamtumfang der im Vertrag vorgesehenen Dienstleistungen
                    entspricht.
                </p>
                <p className="text-zinc-500">
                    Die Anrede in dieser Belehrung folgt dem gesetzlichen
                    Mustertext nach Anlage 1 zu Art. 246a EGBGB.
                </p>
            </LegalSection>

            <LegalSection label="§ 21" title="Muster-Widerrufsformular">
                <p>
                    Das Muster-Widerrufsformular nach Anlage 2 zu Art. 246a § 1
                    Abs. 2 Satz 1 Nr. 1 EGBGB steht als PDF zum Abruf bereit.
                    Seine Verwendung ist nicht vorgeschrieben; der Widerruf kann
                    auch formlos in Textform erklärt werden.
                </p>
                <p>
                    <a
                        href="/withdrawal-form"
                        target="_blank"
                        rel="noopener"
                        className="inline-block border px-5 py-3 text-sm text-white transition-colors hover:border-white hover:bg-white hover:text-black"
                    >
                        Muster-Widerrufsformular (PDF)
                    </a>
                </p>
            </LegalSection>

            <LegalSection label="§ 22" title="Schlussbestimmungen">
                <LegalList
                    variant="paren"
                    items={[
                        "Für Kündigungen, den Widerruf und sonstige Mitteilungen genügt die Textform, etwa per E-Mail oder Ticket.",
                        "Änderungen und Ergänzungen des Vertrags bedürfen der Textform; dies gilt auch für die Aufhebung dieses Formerfordernisses. Der Vorrang von Individualabreden nach § 305b BGB bleibt unberührt.",
                        "Der Kunde kann Rechte und Pflichten aus dem Vertrag nur mit vorheriger Zustimmung des Anbieters in Textform auf Dritte übertragen.",
                        "Die Vertragsparteien versuchen bei Streitigkeiten aus diesem Vertragsverhältnis zunächst eine außergerichtliche Einigung. Der Anbieter ist weder bereit noch verpflichtet, an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.",
                        "Ist der Kunde Kaufmann, juristische Person des öffentlichen Rechts oder öffentlich-rechtliches Sondervermögen, ist der Sitz des Anbieters ausschließlicher Gerichtsstand. Für Verbraucher gelten ausschließlich die gesetzlichen Gerichtsstandsregeln.",
                        "Es gilt das Recht der Bundesrepublik Deutschland unter Ausschluss des UN-Kaufrechts. Für Verbraucher gilt dies nur, soweit hierdurch nicht zwingende Verbraucherschutzvorschriften des Staates eingeschränkt werden, in dem der Kunde seinen gewöhnlichen Aufenthalt hat.",
                        "Sollten einzelne Bestimmungen dieser Bedingungen ganz oder teilweise unwirksam oder undurchführbar sein oder werden, bleibt die Wirksamkeit der übrigen Bestimmungen unberührt. An die Stelle der unwirksamen Bestimmung treten die gesetzlichen Vorschriften.",
                    ]}
                />
            </LegalSection>
        </LegalPage>
    );
}
