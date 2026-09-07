import type { Metadata } from "next";
import LegalPage from "@/lib/components/legal/legal-page";
import { LegalSections, renderLegalText } from "@/lib/legal/render";
import { loadLegalDocument } from "@/lib/legal/repository";
import { legalValues, loadSettings } from "@/lib/settings";

export async function generateMetadata(): Promise<Metadata> {
    const { site } = await loadSettings();

    return {
        title: "Impressum",
        description: `Anbieterkennzeichnung nach § 5 DDG für ${site.name}.`,
    };
}

export default async function Page() {
    const settings = await loadSettings();
    const values = legalValues(settings);
    const { document, updated } = await loadLegalDocument("imprint");

    return (
        <LegalPage
            title={document.title}
            eyebrow={document.eyebrow}
            updated={updated}
            intro={
                document.intro
                    ? document.intro.split("\n\n").map((paragraph, index) => (
                          <p
                              key={paragraph.slice(0, 40)}
                              className={index > 0 ? "mt-4" : undefined}
                          >
                              {renderLegalText(paragraph, values)}
                          </p>
                      ))
                    : undefined
            }
        >
            <LegalSections document={document} values={values} />
        </LegalPage>
    );
}
