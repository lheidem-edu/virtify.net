"use server";

import { and, asc, desc, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-session";
import { db, schema } from "@/lib/db";
import { createId } from "@/lib/db/id";
import { parseDate } from "@/lib/documents/line-items";
import { sendLegalChangeMail } from "@/lib/documents/send";
import { textToItems } from "@/lib/legal/items";
import { defaultDocument, loadSections } from "@/lib/legal/repository";
import {
    LEGAL_KIND_LABEL,
    LEGAL_KIND_PATH,
    LEGAL_KINDS,
    type LegalKind,
} from "@/lib/legal/types";

export type LegalState = {
    status: "idle" | "created" | "saved" | "published" | "announced" | "error";
    message?: string;
};

const VARIANTS = ["paren", "dash", "prose"] as const;

function isKind(value: string): value is LegalKind {
    return (LEGAL_KINDS as readonly string[]).includes(value);
}

/** Every route that shows a legal document, plus the document's own page. */
function revalidateLegal(kind: LegalKind) {
    revalidatePath(LEGAL_KIND_PATH[kind]);
    revalidatePath("/account/admin/legal");
}

/**
 * A new version starts as a copy of what is in force — or of the built-in
 * wording when nothing has been published yet. Editing always happens on a
 * draft: the published text is what customers are being held to and must not
 * change under them while it is being reworked.
 */
export async function createDraft(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const kind = String(data.get("kind") ?? "");

    if (!isKind(kind)) {
        return { status: "error", message: "Unbekanntes Dokument." };
    }

    const documentId = createId("legaldocument");

    try {
        await db.transaction(async (tx) => {
            const existing = await tx
                .select()
                .from(schema.legalDocument)
                .where(eq(schema.legalDocument.kind, kind))
                .orderBy(desc(schema.legalDocument.version));

            if (existing.some((row) => row.status === "draft")) {
                throw new Error("draft-exists");
            }

            const published = existing.find(
                (row) => row.status === "published",
            );

            const source = published
                ? {
                      title: published.title,
                      eyebrow: published.eyebrow,
                      intro: published.intro,
                      sections: await loadSections(published.id),
                  }
                : defaultDocument(kind);

            await tx.insert(schema.legalDocument).values({
                id: documentId,
                kind,
                version: (existing[0]?.version ?? 0) + 1,
                status: "draft",
                title: source.title,
                eyebrow: source.eyebrow ?? null,
                intro: source.intro ?? null,
            });

            await tx.insert(schema.legalSection).values(
                source.sections.map((section, index) => ({
                    id: createId("legalsection"),
                    documentId,
                    position: index + 1,
                    label: section.label ?? null,
                    title: section.title,
                    variant: section.variant,
                    items: section.items,
                })),
            );
        });
    } catch (error) {
        console.error("[admin] creating the legal draft failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "draft-exists"
                    ? "Es gibt bereits einen Entwurf für dieses Dokument."
                    : "Der Entwurf konnte nicht angelegt werden.",
        };
    }

    revalidateLegal(kind);

    return { status: "created", message: documentId };
}

/** Title, eyebrow and the lead paragraph of a draft. */
export async function saveDocument(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const documentId = String(data.get("documentId") ?? "");
    const title = read("title");

    if (!title) {
        return { status: "error", message: "Der Titel ist Pflicht." };
    }

    try {
        const [row] = await db
            .update(schema.legalDocument)
            .set({
                title,
                eyebrow: read("eyebrow") || null,
                intro: read("intro") || null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.legalDocument.id, documentId),
                    eq(schema.legalDocument.status, "draft"),
                ),
            )
            .returning({ kind: schema.legalDocument.kind });

        if (!row) {
            return {
                status: "error",
                message: "Nur ein Entwurf kann bearbeitet werden.",
            };
        }

        revalidateLegal(row.kind);
    } catch (error) {
        console.error("[admin] saving the legal document failed:", error);
        return { status: "error", message: "Speichern hat nicht geklappt." };
    }

    return { status: "saved", message: "Gespeichert." };
}

/** One section of a draft: its number, its heading, its list form, its text. */
export async function saveSection(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const read = (name: string) => String(data.get(name) ?? "").trim();

    const sectionId = String(data.get("sectionId") ?? "");
    const title = read("title");
    const variant = read("variant");
    const items = textToItems(String(data.get("items") ?? ""));

    if (!title) {
        return { status: "error", message: "Die Überschrift ist Pflicht." };
    }

    if (!VARIANTS.includes(variant as (typeof VARIANTS)[number])) {
        return { status: "error", message: "Unbekannte Darstellung." };
    }

    if (items.length === 0) {
        return { status: "error", message: "Der Abschnitt hat keinen Text." };
    }

    try {
        const kind = await withDraftSection(sectionId, async (tx) => {
            await tx
                .update(schema.legalSection)
                .set({ label: read("label") || null, title, variant, items })
                .where(eq(schema.legalSection.id, sectionId));
        });

        revalidateLegal(kind);
    } catch (error) {
        console.error("[admin] saving the legal section failed:", error);
        return {
            status: "error",
            message:
                error instanceof Error && error.message === "not-draft"
                    ? "Nur ein Entwurf kann bearbeitet werden."
                    : "Speichern hat nicht geklappt.",
        };
    }

    return { status: "saved", message: "Gespeichert." };
}

export async function addSection(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const documentId = String(data.get("documentId") ?? "");

    try {
        await db.transaction(async (tx) => {
            const [document] = await tx
                .select()
                .from(schema.legalDocument)
                .where(eq(schema.legalDocument.id, documentId));

            if (document?.status !== "draft") {
                throw new Error("not-draft");
            }

            const sections = await tx
                .select({ position: schema.legalSection.position })
                .from(schema.legalSection)
                .where(eq(schema.legalSection.documentId, documentId))
                .orderBy(desc(schema.legalSection.position))
                .limit(1);

            await tx.insert(schema.legalSection).values({
                id: createId("legalsection"),
                documentId,
                position: (sections[0]?.position ?? 0) + 1,
                title: "Neuer Abschnitt",
                variant: "prose",
                items: ["Text."],
            });

            revalidateLegal(document.kind);
        });
    } catch (error) {
        console.error("[admin] adding a legal section failed:", error);
        return {
            status: "error",
            message: "Der Abschnitt konnte nicht angelegt werden.",
        };
    }

    return { status: "saved" };
}

export async function deleteSection(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const sectionId = String(data.get("sectionId") ?? "");

    try {
        const kind = await withDraftSection(sectionId, async (tx) => {
            await tx
                .delete(schema.legalSection)
                .where(eq(schema.legalSection.id, sectionId));
        });

        revalidateLegal(kind);
    } catch (error) {
        console.error("[admin] deleting a legal section failed:", error);
        return {
            status: "error",
            message: "Der Abschnitt konnte nicht gelöscht werden.",
        };
    }

    return { status: "saved" };
}

/**
 * Moves a section past its neighbour. The documents reference their own
 * paragraphs by number, so order is content — not decoration.
 */
export async function moveSection(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const sectionId = String(data.get("sectionId") ?? "");
    const up = String(data.get("direction") ?? "") === "up";

    try {
        const kind = await withDraftSection(sectionId, async (tx, section) => {
            const neighbours = await tx
                .select()
                .from(schema.legalSection)
                .where(eq(schema.legalSection.documentId, section.documentId))
                .orderBy(asc(schema.legalSection.position));

            const index = neighbours.findIndex((row) => row.id === sectionId);
            const other = neighbours[up ? index - 1 : index + 1];

            if (!other) {
                return;
            }

            await tx
                .update(schema.legalSection)
                .set({ position: other.position })
                .where(eq(schema.legalSection.id, sectionId));

            await tx
                .update(schema.legalSection)
                .set({ position: section.position })
                .where(eq(schema.legalSection.id, other.id));
        });

        revalidateLegal(kind);
    } catch (error) {
        console.error("[admin] moving a legal section failed:", error);
        return { status: "error", message: "Verschieben hat nicht geklappt." };
    }

    return { status: "saved" };
}

/** Shared guard: a section may only be touched while its document is a draft. */
async function withDraftSection(
    sectionId: string,
    write: (
        tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
        section: typeof schema.legalSection.$inferSelect,
    ) => Promise<void>,
) {
    return db.transaction(async (tx) => {
        const [section] = await tx
            .select()
            .from(schema.legalSection)
            .where(eq(schema.legalSection.id, sectionId));

        if (!section) {
            throw new Error("not-found");
        }

        const [document] = await tx
            .select()
            .from(schema.legalDocument)
            .where(eq(schema.legalDocument.id, section.documentId));

        if (document?.status !== "draft") {
            throw new Error("not-draft");
        }

        await write(tx, section);

        return document.kind;
    });
}

/**
 * Puts a draft into force from a date. § 17 of the terms promises six weeks'
 * notice before a change applies, so a date in the past is refused outright:
 * a document cannot start having applied yesterday.
 */
export async function publishDocument(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const documentId = String(data.get("documentId") ?? "");
    const effectiveFrom = parseDate(String(data.get("effectiveFrom") ?? ""));

    if (!effectiveFrom) {
        return {
            status: "error",
            message: "Das Datum fehlt oder ist ungültig.",
        };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (effectiveFrom < today) {
        return {
            status: "error",
            message: "Eine Fassung kann nicht rückwirkend in Kraft treten.",
        };
    }

    try {
        const [row] = await db
            .update(schema.legalDocument)
            .set({
                status: "published",
                effectiveFrom,
                publishedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.legalDocument.id, documentId),
                    eq(schema.legalDocument.status, "draft"),
                ),
            )
            .returning({ kind: schema.legalDocument.kind });

        if (!row) {
            return {
                status: "error",
                message: "Nur ein Entwurf kann in Kraft gesetzt werden.",
            };
        }

        revalidateLegal(row.kind);
    } catch (error) {
        console.error("[admin] publishing the legal document failed:", error);
        return {
            status: "error",
            message: "Die Fassung konnte nicht in Kraft gesetzt werden.",
        };
    }

    return { status: "published", message: "Die Fassung ist gesetzt." };
}

/** Throws a draft away. Only a draft — a published version is a record. */
export async function discardDraft(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const documentId = String(data.get("documentId") ?? "");

    try {
        const [row] = await db
            .delete(schema.legalDocument)
            .where(
                and(
                    eq(schema.legalDocument.id, documentId),
                    eq(schema.legalDocument.status, "draft"),
                ),
            )
            .returning({ kind: schema.legalDocument.kind });

        if (!row) {
            return {
                status: "error",
                message: "Nur ein Entwurf kann verworfen werden.",
            };
        }

        revalidateLegal(row.kind);
    } catch (error) {
        console.error("[admin] discarding the legal draft failed:", error);
        return { status: "error", message: "Verwerfen hat nicht geklappt." };
    }

    return { status: "saved", message: "Der Entwurf ist weg." };
}

/**
 * Tells every account with a running contract that a new version is coming.
 * Deliberately a separate, deliberate click: publishing is reversible until
 * the date arrives, a mail to every customer is not.
 */
export async function announceDocument(
    _previous: LegalState,
    data: FormData,
): Promise<LegalState> {
    await requireAdmin();

    const documentId = String(data.get("documentId") ?? "");

    const [document] = await db
        .select()
        .from(schema.legalDocument)
        .where(eq(schema.legalDocument.id, documentId));

    if (document?.status !== "published" || !document.effectiveFrom) {
        return {
            status: "error",
            message:
                "Nur eine in Kraft gesetzte Fassung kann mitgeteilt werden.",
        };
    }

    if (document.announcedAt) {
        return {
            status: "error",
            message: "Diese Fassung wurde bereits mitgeteilt.",
        };
    }

    // Everyone the change actually binds: an account with a contract that is
    // still running. A prospect who never signed anything gets no mail.
    const recipients = await db
        .selectDistinct({ email: schema.user.email })
        .from(schema.user)
        .innerJoin(schema.contract, eq(schema.contract.userId, schema.user.id))
        .where(ne(schema.contract.status, "ended"));

    let failed = 0;

    for (const recipient of recipients) {
        try {
            await sendLegalChangeMail({
                to: recipient.email,
                documentLabel: LEGAL_KIND_LABEL[document.kind],
                documentPath: LEGAL_KIND_PATH[document.kind],
                effectiveFrom: document.effectiveFrom,
            });
        } catch (error) {
            console.error("[admin] announcing to", recipient.email, error);
            failed++;
        }
    }

    if (failed === recipients.length && recipients.length > 0) {
        return {
            status: "error",
            message: "Keine der Mitteilungen konnte versendet werden.",
        };
    }

    await db
        .update(schema.legalDocument)
        .set({ announcedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.legalDocument.id, documentId));

    revalidateLegal(document.kind);

    return {
        status: "announced",
        message: failed
            ? `${recipients.length - failed} von ${recipients.length} Mitteilungen versendet; ${failed} nicht.`
            : `${recipients.length} Mitteilungen versendet.`,
    };
}
