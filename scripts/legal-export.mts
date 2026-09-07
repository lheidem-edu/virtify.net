/**
 * Writes the three legal documents out as plain text, for pasting somewhere
 * that is not this site.
 *
 *   npm run legal:export
 *
 * It exports what is actually in force — the newest published version whose
 * date has arrived, or the built-in wording when nothing has been published —
 * with the placeholders resolved from the current settings and every link
 * written out as its address. Run it again after publishing a version or
 * changing the settings; the files under legal/ are output, never a source.
 */
import fs from "node:fs";
import path from "node:path";
import { loadLegalDocument } from "@/lib/legal/repository";
import type { LegalItem, LegalKind } from "@/lib/legal/types";
import { LEGAL_KIND_LABEL, LEGAL_KINDS } from "@/lib/legal/types";
import { legalValues, loadSettings } from "@/lib/settings";

const VALUE = /\{\{(\w+)\}\}/g;
const MARKUP = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;

const FILE: Record<LegalKind, string> = {
    terms: "AGB.txt",
    privacy: "Datenschutzerklaerung.txt",
    imprint: "Impressum.txt",
};

const settings = await loadSettings();
const values = legalValues(settings) as Record<string, string | number>;
const base = settings.site.url.replace(/\/$/, "");

function absolute(href: string) {
    if (href.startsWith("mailto:") || /^https?:\/\//.test(href)) {
        return href;
    }
    return `${base}${href.startsWith("/") ? "" : "/"}${href}`;
}

function text(source: string) {
    // Values first: a placeholder can sit inside a link's label or its href
    // ([{{operatorEmail}}](mailto:{{operatorEmail}})), and resolving the two
    // in one pass would leave those standing.
    const resolved = source.replace(VALUE, (match, key) => {
        const value = values[key];
        return value === undefined ? match : String(value);
    });

    return resolved.replace(MARKUP, (_match, label, href, code, bold) => {
        if (label !== undefined) {
            const target = absolute(href);
            // A mail address that links to itself reads as itself.
            return target === label || target === `mailto:${label}`
                ? label
                : `${label} (${target})`;
        }
        return code ?? bold;
    });
}

/** Indents the continuation lines of an item under its own marker. */
function indent(body: string, width: number) {
    return body.split("\n").join(`\n${" ".repeat(width)}`);
}

function renderItem(item: LegalItem, marker: string) {
    const lead = typeof item === "string" ? item : item.text;
    const nested = typeof item === "string" ? [] : item.items;
    const lines = [`${marker}${indent(text(lead), marker.length)}`];

    for (const entry of nested) {
        const bullet = `${" ".repeat(marker.length)}– `;
        lines.push(`${bullet}${indent(text(entry), bullet.length)}`);
    }

    return lines.join("\n");
}

const directory = path.join(process.cwd(), "legal");
fs.mkdirSync(directory, { recursive: true });

for (const kind of LEGAL_KINDS) {
    const { document, updated, version } = await loadLegalDocument(kind);
    const out: string[] = [document.title.toUpperCase(), ""];

    out.push(
        version
            ? `Stand: ${updated} (Fassung ${version})`
            : `Stand: ${updated}`,
        "",
    );

    if (document.intro) {
        for (const paragraph of document.intro.split("\n\n")) {
            out.push(text(paragraph), "");
        }
    }

    for (const section of document.sections) {
        out.push(
            "",
            [section.label, section.title].filter(Boolean).join(" "),
            "",
        );

        section.items.forEach((item, index) => {
            const marker =
                section.variant === "paren"
                    ? `(${index + 1}) `
                    : section.variant === "dash"
                      ? "– "
                      : "";
            out.push(renderItem(item, marker), "");
        });

        if (section.action) {
            out.push(
                `${section.action.label}: ${absolute(section.action.href)}`,
                "",
            );
        }
    }

    const body = `${out
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()}\n`;
    fs.writeFileSync(path.join(directory, FILE[kind]), body, "utf8");
    console.log(
        `${LEGAL_KIND_LABEL[kind]} -> legal/${FILE[kind]} (${body.split("\n").length} lines)`,
    );
}
