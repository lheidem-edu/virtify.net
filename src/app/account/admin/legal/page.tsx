import { desc } from "drizzle-orm";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-session";
import PageHeader from "@/lib/components/account/page-header";
import StatusBadge from "@/lib/components/account/status-badge";
import { db, schema } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { itemsToText } from "@/lib/legal/items";
import { loadSectionRows } from "@/lib/legal/repository";
import {
    LEGAL_KIND_LABEL,
    LEGAL_KIND_PATH,
    LEGAL_KINDS,
    type LegalItem,
} from "@/lib/legal/types";
import { LEGAL_PLACEHOLDERS } from "@/lib/settings";
import {
    AddSectionForm,
    AnnounceAction,
    CreateDraftForm,
    DiscardDraftAction,
    DocumentForm,
    PublishForm,
    SectionForm,
} from "./legal-actions";

const LINK =
    "underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-foreground";

/** § 17 of the terms promises six weeks before a change applies. */
function suggestedDate() {
    const date = new Date();
    date.setDate(date.getDate() + 42);
    return date.toISOString().slice(0, 10);
}

export default async function Page() {
    await requireAdmin();

    const rows = await db
        .select()
        .from(schema.legalDocument)
        .orderBy(desc(schema.legalDocument.version));

    const draftSections = new Map<
        string,
        Awaited<ReturnType<typeof loadSectionRows>>
    >();

    for (const row of rows.filter((entry) => entry.status === "draft")) {
        draftSections.set(row.id, await loadSectionRows(row.id));
    }

    return (
        <>
            <PageHeader
                title="Rechtstexte"
                intro="AGB, Datenschutzerklärung und Impressum. Bearbeitet wird immer ein Entwurf; in Kraft tritt er zu einem Datum, das du bestimmst. Fassungen bleiben erhalten — nur so lässt sich später belegen, was bei einem Vertragsschluss galt."
            />

            <div className="border-b px-6 py-10 md:px-10 md:py-12">
                <h2 className="mb-4 text-sm font-medium tracking-tight">
                    Platzhalter
                </h2>
                <p className="mb-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                    Werte und Links werden nicht abgetippt, sondern eingesetzt.
                    So bleibt eine Anschrift oder eine Frist an einer Stelle
                    gepflegt und geht in den Texten nicht veraltet:
                </p>
                <div className="flex flex-wrap gap-2">
                    {LEGAL_PLACEHOLDERS.map((name) => (
                        <code
                            key={name}
                            className="rounded border px-2 py-1 font-mono text-xs text-muted-foreground"
                        >
                            {`{{${name}}}`}
                        </code>
                    ))}
                </div>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                    Links schreibst du als{" "}
                    <code className="font-mono text-xs">
                        [Kundenbereich](/account)
                    </code>
                    , eine Kennung in Schreibmaschinenschrift mit{" "}
                    <code className="font-mono text-xs">`DE12…`</code>, eine
                    Hervorhebung mit{" "}
                    <code className="font-mono text-xs">
                        **Widerrufsrecht**
                    </code>
                    . Im Text trennt eine Leerzeile zwei Punkte; eine Zeile, die
                    mit <code className="font-mono text-xs">- </code> beginnt,
                    wird zur Unterliste des Punktes darüber.
                </p>
            </div>

            {LEGAL_KINDS.map((kind) => {
                const versions = rows.filter((row) => row.kind === kind);
                const draft = versions.find((row) => row.status === "draft");
                const published = versions.filter(
                    (row) => row.status === "published",
                );
                // The same order the public page resolves in: the latest
                // effective date, and of two that share one the later
                // version — otherwise Verwaltung would name a different
                // Fassung than the one a visitor is reading.
                const inForce = published
                    .filter(
                        (row) =>
                            row.effectiveFrom &&
                            row.effectiveFrom <= new Date(),
                    )
                    .sort(
                        (a, b) =>
                            Number(b.effectiveFrom) - Number(a.effectiveFrom) ||
                            b.version - a.version,
                    )
                    .at(0);
                const upcoming = published.filter(
                    (row) =>
                        row.effectiveFrom && row.effectiveFrom > new Date(),
                );
                // The newest published version that still owes its notice.
                // Including one that took effect immediately — otherwise the
                // mitteilung for it could never be sent at all.
                const unannounced = published.find((row) => !row.announcedAt);

                return (
                    <div
                        key={kind}
                        className="border-b px-6 py-10 md:px-10 md:py-12"
                    >
                        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
                            <h2 className="text-sm font-medium tracking-tight">
                                {LEGAL_KIND_LABEL[kind]}
                            </h2>
                            <Link
                                href={LEGAL_KIND_PATH[kind]}
                                className={`text-sm ${LINK}`}
                            >
                                Seite ansehen
                            </Link>
                        </div>

                        <dl className="mb-8 grid gap-6 sm:grid-cols-3">
                            <div>
                                <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                                    In Kraft
                                </dt>
                                <dd className="mt-2 text-sm">
                                    {inForce
                                        ? `Fassung ${inForce.version}, seit ${formatDate(inForce.effectiveFrom)}`
                                        : "Auslieferungsfassung aus dem Code"}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                                    Angekündigt
                                </dt>
                                <dd className="mt-2 text-sm">
                                    {upcoming.length > 0
                                        ? upcoming
                                              .map(
                                                  (row) =>
                                                      `Fassung ${row.version} ab ${formatDate(row.effectiveFrom)}`,
                                              )
                                              .join(", ")
                                        : "—"}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                                    Fassungen
                                </dt>
                                <dd className="mt-2 text-sm">
                                    {published.length}
                                </dd>
                            </div>
                        </dl>

                        {unannounced ? (
                            <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border p-4">
                                <StatusBadge
                                    label={`Fassung ${unannounced.version}`}
                                    tone="warning"
                                />
                                <span className="text-sm text-muted-foreground">
                                    {upcoming.includes(unannounced)
                                        ? `gilt ab ${formatDate(unannounced.effectiveFrom)}`
                                        : `gilt seit ${formatDate(unannounced.effectiveFrom)}`}{" "}
                                    · noch nicht mitgeteilt
                                </span>
                                <AnnounceAction
                                    documentId={unannounced.id}
                                    label={LEGAL_KIND_LABEL[kind]}
                                    effective={formatDate(
                                        unannounced.effectiveFrom,
                                    )}
                                />
                            </div>
                        ) : null}

                        {draft ? (
                            <div className="space-y-8">
                                <div className="flex flex-wrap items-center gap-3">
                                    <StatusBadge
                                        label={`Entwurf, Fassung ${draft.version}`}
                                        tone="muted"
                                    />
                                    <DiscardDraftAction documentId={draft.id} />
                                </div>

                                <DocumentForm
                                    documentId={draft.id}
                                    title={draft.title}
                                    eyebrow={draft.eyebrow ?? ""}
                                    intro={draft.intro ?? ""}
                                />

                                <div className="space-y-6">
                                    {(draftSections.get(draft.id) ?? []).map(
                                        (section, index, all) => (
                                            <SectionForm
                                                key={section.id}
                                                sectionId={section.id}
                                                label={section.label ?? ""}
                                                title={section.title}
                                                variant={section.variant}
                                                items={itemsToText(
                                                    section.items as LegalItem[],
                                                )}
                                                first={index === 0}
                                                last={index === all.length - 1}
                                            />
                                        ),
                                    )}
                                    <AddSectionForm documentId={draft.id} />
                                </div>

                                <div className="border-t pt-8">
                                    <h3 className="mb-4 text-sm font-medium tracking-tight">
                                        In Kraft setzen
                                    </h3>
                                    <PublishForm
                                        documentId={draft.id}
                                        suggested={suggestedDate()}
                                    />
                                </div>
                            </div>
                        ) : (
                            <CreateDraftForm kind={kind} />
                        )}
                    </div>
                );
            })}
        </>
    );
}
