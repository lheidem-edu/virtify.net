import Link from "next/link";
import { Button } from "@/components/ui/button";
import LegalList from "@/lib/components/legal/legal-list";
import LegalSection from "@/lib/components/legal/legal-section";
import type {
    LegalDocumentData,
    LegalItem,
    LegalSectionData,
} from "@/lib/legal/types";

const linkClass =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-white";

/**
 * `{{key}}`, `[label](href)` and `` `code` `` — nothing else. The syntax stays
 * small because every addition is another thing an editor can get wrong.
 */
const TOKEN =
    /\{\{(\w+)\}\}|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\n/g;

export type LegalValues = Record<string, string | number>;

function resolve(text: string, values: LegalValues) {
    return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
        key in values ? String(values[key]) : whole,
    );
}

/**
 * Turns one stored string into React. Values are substituted, links become
 * real links — an internal one through next/link so it prefetches like the
 * rest of the site, a mailto: as a plain anchor.
 */
export function renderLegalText(text: string, values: LegalValues) {
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    let key = 0;

    TOKEN.lastIndex = 0;

    for (
        let match = TOKEN.exec(text);
        match !== null;
        match = TOKEN.exec(text)
    ) {
        if (match.index > cursor) {
            nodes.push(text.slice(cursor, match.index));
        }

        const [whole, valueKey, label, href, code, strong] = match;

        if (valueKey) {
            nodes.push(valueKey in values ? String(values[valueKey]) : whole);
        } else if (code) {
            nodes.push(
                <span key={key++} className="font-mono">
                    {resolve(code, values)}
                </span>,
            );
        } else if (strong) {
            nodes.push(
                <span key={key++} className="font-medium text-zinc-200">
                    {resolve(strong, values)}
                </span>,
            );
        } else if (whole === "\n") {
            // An address block is one item with real line breaks in it.
            nodes.push(<br key={key++} />);
        } else if (label && href) {
            const target = resolve(href, values);
            const text = resolve(label, values);

            nodes.push(
                target.startsWith("/") ? (
                    <Link key={key++} href={target} className={linkClass}>
                        {text}
                    </Link>
                ) : (
                    <a key={key++} href={target} className={linkClass}>
                        {text}
                    </a>
                ),
            );
        }

        cursor = match.index + whole.length;
    }

    if (cursor < text.length) {
        nodes.push(text.slice(cursor));
    }

    return nodes;
}

function renderItem(item: LegalItem, values: LegalValues) {
    if (typeof item === "string") {
        return renderLegalText(item, values);
    }

    return (
        <>
            {renderLegalText(item.text, values)}
            <LegalList
                items={item.items.map((entry) =>
                    renderLegalText(entry, values),
                )}
            />
        </>
    );
}

export function LegalSectionView({
    section,
    values,
}: {
    section: LegalSectionData;
    values: LegalValues;
}) {
    const action = section.action;

    return (
        <LegalSection label={section.label} title={section.title}>
            {section.variant === "prose" ? (
                section.items.map((item) => (
                    <p key={typeof item === "string" ? item : item.text}>
                        {renderItem(item, values)}
                    </p>
                ))
            ) : (
                <LegalList
                    variant={section.variant}
                    items={section.items.map((item) =>
                        renderItem(item, values),
                    )}
                />
            )}
            {action ? (
                <div className="pt-2">
                    <Button
                        nativeButton={false}
                        render={
                            action.href.startsWith("/") &&
                            !action.href.startsWith("/withdrawal-form") ? (
                                <Link href={resolve(action.href, values)} />
                            ) : (
                                // biome-ignore lint/a11y/useAnchorContent: the label is passed as the Button's children
                                <a
                                    href={resolve(action.href, values)}
                                    target="_blank"
                                    rel="noopener"
                                />
                            )
                        }
                        variant="outline"
                        size="lg"
                    >
                        {renderLegalText(action.label, values)}
                    </Button>
                </div>
            ) : null}
        </LegalSection>
    );
}

export function LegalSections({
    document,
    values,
}: {
    document: LegalDocumentData;
    values: LegalValues;
}) {
    return (
        <>
            {document.sections.map((section, index) => (
                <LegalSectionView
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered content, two sections may share a title
                    key={`${index}-${section.label ?? section.title}`}
                    section={section}
                    values={values}
                />
            ))}
        </>
    );
}
