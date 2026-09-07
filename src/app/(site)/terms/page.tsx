import type { Metadata } from "next";
import LegalPage from "@/lib/components/legal/legal-page";
import { LegalSections, renderLegalText } from "@/lib/legal/render";
import { loadLegalDocument } from "@/lib/legal/repository";
import { legalValues, loadSettings } from "@/lib/settings";

/**
 * A version can be published to apply from a future day. Nothing happens on
 * that day — no save, no request to revalidate — so the page has to come back
 * for it by itself. An hour of lag on a date that is set in days is close
 * enough, and it keeps the page static the rest of the time.
 */
export const revalidate = 3600;

export async function generateMetadata(): Promise<Metadata> {
    const { operator, site } = await loadSettings();

    return {
        title: "Allgemeine Geschäftsbedingungen",
        description: `Allgemeine Geschäftsbedingungen für die Bereitstellung von KVM-Instanzen durch ${operator.name} (${site.name}).`,
    };
}

export default async function Page() {
    const settings = await loadSettings();
    const values = legalValues(settings);
    const { document, updated } = await loadLegalDocument("terms");

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
