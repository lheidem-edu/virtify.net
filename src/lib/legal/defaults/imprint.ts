import type { LegalDocumentData } from "@/lib/legal/types";

/**
 * The text as it stood when the documents became editable. It is what a fresh
 * installation serves and what the first published version is copied from, so
 * it is the wording itself — unchanged, not a summary of it. Values and links
 * are placeholders; the syntax is described in @/lib/legal/types.
 */
const document: LegalDocumentData = {
    title: "Impressum",
    intro: "Anbieterkennzeichnung nach § 5 DDG für {{siteName}}.",
    sections: [
        {
            title: "Anbieter",
            variant: "prose",
            items: [
                "{{operatorName}}\n{{operatorStreet}}\n{{operatorCity}}\n{{operatorCountry}}",
                "{{siteName}} ist eine nicht eingetragene Einzelunternehmung; es besteht kein Handelsregistereintrag.",
            ],
        },
        {
            title: "Kontakt",
            variant: "prose",
            items: [
                "E-Mail: [{{operatorEmail}}](mailto:{{operatorEmail}})",
                "Anfragen werden ausschließlich elektronisch entgegengenommen. Eine Telefonnummer wird nicht vorgehalten; eine schnelle elektronische Kontaktaufnahme und unmittelbare Kommunikation ist über die vorstehende Adresse sichergestellt.",
            ],
        },
        {
            title: "Umsatzsteuer",
            variant: "prose",
            items: [
                "Umsatzsteuer-Identifikationsnummer gemäß § 27 a UStG: `{{operatorVatId}}`",
                "Als Kleinunternehmer im Sinne des § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet und in Rechnungen nicht ausgewiesen. Die Umsatzsteuer-Identifikationsnummer wird für innergemeinschaftliche Leistungen und Erwerbe verwendet.",
            ],
        },
        {
            title: "Verbraucherstreitbeilegung",
            variant: "prose",
            items: [
                "Wir sind weder bereit noch verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen (§ 36 VSBG).",
            ],
        },
    ],
};

export default document;
