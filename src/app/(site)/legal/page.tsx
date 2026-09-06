import type { Metadata } from "next";
import LegalPage from "@/lib/components/legal/legal-page";
import LegalSection from "@/lib/components/legal/legal-section";
import { operator, site } from "@/lib/site";

export const metadata: Metadata = {
    title: "Impressum",
    description: `Anbieterkennzeichnung nach § 5 DDG für ${site.name}.`,
};

export default function Page() {
    return (
        <LegalPage
            title="Impressum"
            intro={`Anbieterkennzeichnung nach § 5 DDG für ${site.name}.`}
        >
            <LegalSection title="Anbieter">
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
                    {site.name} ist eine nicht eingetragene Einzelunternehmung;
                    es besteht kein Handelsregistereintrag.
                </p>
            </LegalSection>

            <LegalSection title="Kontakt">
                <p>
                    E-Mail:{" "}
                    <a
                        href={`mailto:${operator.email}`}
                        className="text-white underline underline-offset-4 decoration-zinc-600 transition-colors hover:decoration-white"
                    >
                        {operator.email}
                    </a>
                </p>
                <p>
                    Anfragen werden ausschließlich elektronisch
                    entgegengenommen. Eine Telefonnummer wird nicht vorgehalten;
                    eine schnelle elektronische Kontaktaufnahme und unmittelbare
                    Kommunikation ist über die vorstehende Adresse
                    sichergestellt.
                </p>
            </LegalSection>

            <LegalSection title="Umsatzsteuer">
                <p>
                    Umsatzsteuer-Identifikationsnummer gemäß § 27 a UStG:{" "}
                    <span className="font-mono">{operator.vatId}</span>
                </p>
                <p>
                    Als Kleinunternehmer im Sinne des § 19 Abs. 1 UStG wird
                    keine Umsatzsteuer berechnet und in Rechnungen nicht
                    ausgewiesen. Die Umsatzsteuer-Identifikationsnummer wird für
                    innergemeinschaftliche Leistungen und Erwerbe verwendet.
                </p>
            </LegalSection>

            <LegalSection title="Verbraucherstreitbeilegung">
                <p>
                    Wir sind weder bereit noch verpflichtet, an
                    Streitbeilegungsverfahren vor einer
                    Verbraucherschlichtungsstelle teilzunehmen (§ 36 VSBG).
                </p>
            </LegalSection>
        </LegalPage>
    );
}
