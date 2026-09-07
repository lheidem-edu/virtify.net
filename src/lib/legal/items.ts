import type { LegalItem } from "@/lib/legal/types";

/**
 * The editor's textarea format. Items are separated by a blank line, so a
 * single newline can stay inside one (the Impressum's address is one item
 * with real line breaks). A line beginning with "- " is a nested list entry
 * belonging to the item above it.
 *
 *     Untersagt sind insbesondere:
 *     - rechtswidrige Handlungen jeglicher Art,
 *     - der Versand unerwünschter elektronischer Nachrichten,
 *
 *     Der nächste Absatz.
 */

export function itemsToText(items: LegalItem[]) {
    return items
        .map((item) =>
            typeof item === "string"
                ? item
                : [item.text, ...item.items.map((entry) => `- ${entry}`)].join(
                      "\n",
                  ),
        )
        .join("\n\n");
}

export function textToItems(text: string): LegalItem[] {
    return text
        .replace(/\r\n/g, "\n")
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
            const lines = block.split("\n");
            const nested = lines.filter((line) =>
                line.trimStart().startsWith("- "),
            );

            if (nested.length === 0) {
                return block;
            }

            const lead = lines
                .filter((line) => !line.trimStart().startsWith("- "))
                .join("\n")
                .trim();

            return {
                text: lead,
                items: nested.map((line) => line.trimStart().slice(2).trim()),
            };
        });
}
