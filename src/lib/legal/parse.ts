import { itemsToText, textToItems } from "@/lib/legal/items";
import type { LegalDocumentData, LegalVariant } from "@/lib/legal/types";

/**
 * The plain-text form of a legal document. It exists so the built-in wording
 * is text rather than five hundred lines of generated TypeScript: it can be
 * read, diffed and edited by someone who does not write code.
 *
 *     @title Allgemeine Geschäftsbedingungen
 *     @eyebrow Rechtliches
 *
 *     @intro
 *     Erster Absatz.
 *
 *     Zweiter Absatz.
 *
 *     @section § 7 | Vergütung und Zahlung | paren
 *     Erster Punkt.
 *
 *     Zweiter Punkt, mit Unterliste:
 *     - eins
 *     - zwei
 *
 *     @section | Anbieter | prose
 *     @button Muster-Widerrufsformular (PDF) -> /withdrawal-form
 *     Text des Abschnitts.
 *
 * Inside the text, the same syntax as the editor: {{platzhalter}},
 * [Beschriftung](/pfad), `Kennung`, **Hervorhebung**, a blank line between
 * items, "- " for a sublist, a single newline for a line break.
 */

const VARIANTS: LegalVariant[] = ["paren", "dash", "prose"];

export function parseLegalDocument(text: string): LegalDocumentData {
    const document: LegalDocumentData = { title: "", sections: [] };

    let target: "intro" | "section" | null = null;
    let buffer: string[] = [];

    const flush = () => {
        const body = buffer.join("\n").trim();
        buffer = [];

        if (!body) {
            return;
        }

        if (target === "intro") {
            document.intro = body;
            return;
        }

        const section = document.sections.at(-1);

        if (section) {
            section.items = textToItems(body);
        }
    };

    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
        const directive = /^@(\w+)\s*(.*)$/.exec(line);

        if (!directive) {
            buffer.push(line);
            continue;
        }

        const [, name, rest] = directive;

        if (name === "title" || name === "eyebrow") {
            flush();
            target = null;
            document[name] = rest.trim();
            continue;
        }

        if (name === "intro") {
            flush();
            target = "intro";
            continue;
        }

        if (name === "section") {
            flush();
            target = "section";

            const [label, title, variant] = rest
                .split("|")
                .map((part) => part.trim());

            document.sections.push({
                ...(label ? { label } : {}),
                title: title ?? "",
                variant: VARIANTS.includes(variant as LegalVariant)
                    ? (variant as LegalVariant)
                    : "prose",
                items: [],
            });
            continue;
        }

        if (name === "button") {
            const [label, href] = rest.split("->").map((part) => part.trim());
            const section = document.sections.at(-1);

            if (section && label && href) {
                section.action = { label, href };
            }
            continue;
        }

        // An unknown directive is text that happens to start with @; keeping
        // it is safer than dropping a sentence out of a legal document.
        buffer.push(line);
    }

    flush();

    return document;
}

/** The inverse, so the format can be checked against what it came from. */
export function serialiseLegalDocument(document: LegalDocumentData) {
    const parts = [`@title ${document.title}`];

    if (document.eyebrow) {
        parts.push(`@eyebrow ${document.eyebrow}`);
    }

    if (document.intro) {
        parts.push("", "@intro", document.intro);
    }

    for (const section of document.sections) {
        parts.push(
            "",
            `@section ${[section.label ?? "", section.title, section.variant].join(" | ").trimStart()}`,
        );

        if (section.action) {
            parts.push(
                `@button ${section.action.label} -> ${section.action.href}`,
            );
        }

        parts.push(itemsToText(section.items));
    }

    return `${parts.join("\n")}\n`;
}
