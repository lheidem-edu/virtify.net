import {
    index,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { timestamps, ulidFk, ulidPk } from "./_columns";

/**
 * AGB, Datenschutzerklärung and Impressum as versioned data. The wording a
 * version starts from lives in src/server/legal/defaults/*.txt.
 */

export const legalKind = pgEnum("legal_kind", ["terms", "privacy", "imprint"]);

export const legalStatus = pgEnum("legal_status", [
    "draft",
    "published",
    "archived",
]);

/**
 * One version of one legal document. Versions are kept rather than
 * overwritten: § 17 of the terms promises six weeks' notice before a change
 * takes effect, which only means something if the fassung that was in force
 * at any given moment can still be produced.
 */
export const legalDocument = pgTable(
    "legal_document",
    {
        id: ulidPk("legaldocument"),
        kind: legalKind("kind").notNull(),
        version: integer("version").notNull(),
        status: legalStatus("status").notNull().default("draft"),

        title: text("title").notNull(),
        eyebrow: text("eyebrow"),
        intro: text("intro"),

        /** The day it starts to apply; never in the past when published. */
        effectiveFrom: timestamp("effective_from", { mode: "date" }),
        publishedAt: timestamp("published_at"),
        /** Set when the customers were told, so it is not sent twice. */
        announcedAt: timestamp("announced_at"),

        ...timestamps(),
    },
    (table) => [index("legal_document_kind_idx").on(table.kind)],
);

export const legalSection = pgTable(
    "legal_section",
    {
        id: ulidPk("legalsection"),
        documentId: ulidFk("document_id")
            .notNull()
            .references(() => legalDocument.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        /** "§ 7", "01" — the two documents number differently. */
        label: text("label"),
        title: text("title").notNull(),
        /** paren | dash | prose, see src/lib/legal/types.ts. */
        variant: text("variant").notNull().default("paren"),
        /** The items, in order; a nested list is encoded in the item itself. */
        items: jsonb("items").notNull(),
    },
    (table) => [index("legal_section_document_id_idx").on(table.documentId)],
);
