import "server-only";
import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { legalUpdated } from "@/lib/site";
import { parseLegalDocument } from "@/server/legal/parse";
import {
    LEGAL_KINDS,
    type LegalDocumentData,
    type LegalItem,
    type LegalKind,
    type LegalVariant,
} from "@/server/legal/types";

/**
 * The text a visitor sees: the newest published version whose effective date
 * has arrived, and the built-in wording until one exists. Keeping a fallback
 * is what makes a fresh database serve a complete document — and it is the
 * wording the first version is copied from.
 *
 * That wording lives in defaults/*.txt beside this file, in the format
 * @/server/legal/parse describes. Text rather than code, because it is text: it
 * can be read, diffed and corrected without a build step, and the person who
 * has to answer for its content does not have to write TypeScript to change
 * it. The files are read once, at import — an installation missing them has a
 * packaging fault, and finding that out at startup beats finding it out from
 * an empty Impressum.
 */

const directory = path.join(
    process.cwd(),
    "src",
    "server",
    "legal",
    "defaults",
);

const DEFAULTS = Object.fromEntries(
    LEGAL_KINDS.map((kind) => [
        kind,
        parseLegalDocument(
            fs.readFileSync(path.join(directory, `${kind}.txt`), "utf8"),
        ),
    ]),
) as Record<LegalKind, LegalDocumentData>;

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
            // Two versions can share an effective date — the second one
            // published that day is the one that applies.
            .orderBy(
                desc(schema.legalDocument.effectiveFrom),
                desc(schema.legalDocument.version),
            )
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

/**
 * Which fassung of a legal document is in force right now, as a thing that
 * can be stored on an order.
 *
 * § 21 of the terms promises six weeks' notice before a change applies,
 * which is only worth anything if what a customer accepted on a given day
 * can still be produced. The checkout therefore writes the version down
 * rather than a boolean, and `label` carries the answer in words for the
 * case where no version has been published at all — "Fassung null" is not
 * something to tell a judge.
 */
export type LegalVersionRef = {
    documentId: string | null;
    version: number | null;
    label: string;
};

export async function currentLegalVersion(
    executor: Pick<typeof db, "select">,
    kind: LegalKind,
): Promise<LegalVersionRef> {
    const [row] = await executor
        .select({
            id: schema.legalDocument.id,
            version: schema.legalDocument.version,
            effectiveFrom: schema.legalDocument.effectiveFrom,
        })
        .from(schema.legalDocument)
        .where(
            and(
                eq(schema.legalDocument.kind, kind),
                eq(schema.legalDocument.status, "published"),
                lte(schema.legalDocument.effectiveFrom, new Date()),
            ),
        )
        .orderBy(
            desc(schema.legalDocument.effectiveFrom),
            desc(schema.legalDocument.version),
        )
        .limit(1);

    if (!row) {
        return {
            documentId: null,
            version: null,
            label: `Eingebaute Fassung, Stand ${legalUpdated}`,
        };
    }

    return {
        documentId: row.id,
        version: row.version,
        label: row.effectiveFrom
            ? `Fassung ${row.version}, gültig ab ${dateLabel.format(row.effectiveFrom)}`
            : `Fassung ${row.version}`,
    };
}
