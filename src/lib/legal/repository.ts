import "server-only";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import imprintDefault from "@/lib/legal/defaults/imprint";
import privacyDefault from "@/lib/legal/defaults/privacy";
import termsDefault from "@/lib/legal/defaults/terms";
import type {
    LegalDocumentData,
    LegalItem,
    LegalKind,
    LegalVariant,
} from "@/lib/legal/types";
import { legalUpdated } from "@/lib/site";

/**
 * The text a visitor sees: the newest published version whose effective date
 * has arrived, and the built-in wording until one exists. Keeping the file as
 * the fallback is what makes a fresh database serve a complete document — and
 * it is the wording the first version is copied from.
 */

const DEFAULTS: Record<LegalKind, LegalDocumentData> = {
    terms: termsDefault,
    privacy: privacyDefault,
    imprint: imprintDefault,
};

const dateLabel = new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Berlin",
});

export type LoadedLegalDocument = {
    document: LegalDocumentData;
    /** Rendered as "Stand: …" in the header. */
    updated: string;
    /** Null while the built-in wording is being served. */
    version: number | null;
};

export async function loadLegalDocument(
    kind: LegalKind,
): Promise<LoadedLegalDocument> {
    try {
        const [row] = await db
            .select()
            .from(schema.legalDocument)
            .where(
                and(
                    eq(schema.legalDocument.kind, kind),
                    eq(schema.legalDocument.status, "published"),
                    lte(schema.legalDocument.effectiveFrom, new Date()),
                ),
            )
            .orderBy(desc(schema.legalDocument.effectiveFrom))
            .limit(1);

        if (!row) {
            return {
                document: DEFAULTS[kind],
                updated: legalUpdated,
                version: null,
            };
        }

        return {
            document: {
                title: row.title,
                eyebrow: row.eyebrow ?? undefined,
                intro: row.intro ?? undefined,
                sections: await loadSections(row.id),
            },
            updated: row.effectiveFrom
                ? dateLabel.format(row.effectiveFrom)
                : legalUpdated,
            version: row.version,
        };
    } catch (error) {
        // A legal page that cannot be served is worse than a slightly stale
        // one, and the built-in wording is never wrong — only never edited.
        console.error("[legal] falling back to the built-in wording:", error);

        return {
            document: DEFAULTS[kind],
            updated: legalUpdated,
            version: null,
        };
    }
}

export async function loadSections(documentId: string) {
    const rows = await db
        .select()
        .from(schema.legalSection)
        .where(eq(schema.legalSection.documentId, documentId))
        .orderBy(asc(schema.legalSection.position));

    return rows.map((row) => ({
        label: row.label ?? undefined,
        title: row.title,
        variant: row.variant as LegalVariant,
        items: row.items as LegalItem[],
    }));
}

/** The rows themselves, for the editor — it needs the ids the view does not. */
export async function loadSectionRows(documentId: string) {
    return db
        .select()
        .from(schema.legalSection)
        .where(eq(schema.legalSection.documentId, documentId))
        .orderBy(asc(schema.legalSection.position));
}

/** The wording a new version starts from when nothing has been published. */
export function defaultDocument(kind: LegalKind) {
    return DEFAULTS[kind];
}
