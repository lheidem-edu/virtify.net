import "server-only";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { type db as defaultDb, schema } from "@/db";
import { type Locale, toLocale } from "@/i18n/locale";
import { translator } from "@/i18n/messages";
import { createId } from "@/lib/ulid";
import { logMailError, type MailTransport, mailTransport } from "@/server/mail";
import { renderEmailWith } from "@/server/mail/layout";
import { mailTemplate } from "@/server/mail/templates";
import type { MailText, RenderedMail } from "@/server/mail/templates/types";
import { loadSettings, type Settings } from "@/server/settings";
import { documentStorage } from "@/server/storage";

/**
 * The one way an automatic mail leaves this installation.
 *
 * ## A `pending` row *is* the request
 *
 * The web process holds no pg-boss instance (`src/server/jobs/worker.ts`) and
 * is not going to grow one, so there is nothing to `send` a job to from a
 * server action or a webhook. The row is the work, exactly as
 * `provisioning_task` is: the worker's `mail/run` pass drains it, the
 * operator's „jetzt senden" runs the same function against the same claim,
 * and those two cannot double-send, which is the only property that matters.
 *
 * ## Both directions
 *
 * The attempt is counted **at the claim**, not after the send. A process
 * killed between claiming and recording would otherwise lose the count, and
 * the row would be retried for ever — which for mail means for ever sending.
 *
 * ## The three ways a send can end, and why they are three
 *
 *  - **It threw.** `failed`, with a backoff, and retried while attempts
 *    remain. A relay that accepted the message and then dropped the
 *    connection will produce a second copy on the retry; that is the residual
 *    risk and it is taken deliberately, because the alternative — treating
 *    every network hiccup as "ask a human" — is a queue that stops. A
 *    notification arriving twice is the lesser failure. (An *invoice* is not
 *    a notification: it arrives as an attachment to one, and the document
 *    itself is immutable and numbered, so a second copy of the mail is still
 *    one invoice.)
 *  - **It returned and the recording threw.** `sending`, left exactly as it
 *    is, and a claim that goes stale becomes **`unknown` — never
 *    `pending`**. The customer may be holding that mail; an automatic retry
 *    would be the second copy, and unlike the case above we have no reason to
 *    think the first one failed. This is Phase 8's expiring claim with the
 *    opposite resolution, because a mail has no provider-side id to ask
 *    about: there is no "does VM 101 exist" for a message. An operator
 *    decides, and their decision is a new row.
 *  - **The ladder ran out.** `abandoned`, named by the failure that was the
 *    last one — not left `failed` for a sweep to read sixty times an hour and
 *    never act on.
 */

type Tx = Pick<typeof defaultDb, "insert" | "select" | "update">;
type Db = Pick<typeof defaultDb, "insert" | "select" | "update">;

/**
 * How long a claim is good for.
 *
 * Fifteen minutes: an SMTP send gives up after twenty seconds and a Graph
 * send honours a `Retry-After` with a capped backoff, so anything still
 * `sending` after this is a process that died rather than one that is slow.
 * Generous rather than tight on purpose — the resolution of a stale claim is
 * `unknown`, which needs a person, and declaring one too early is how a
 * healthy queue grows a pile of them.
 */
export const CLAIM_TIMEOUT_MS = 15 * 60_000;

/** The default ladder. Five tries over roughly half an hour. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Exponential from a minute, capped at an hour — the same shape
 * `provisioning_task` uses, and capped for the same reason: past the fourth
 * attempt it is waiting for a person, and a six-hour step would mean the
 * person's fix does not take effect until the evening.
 */
export function mailBackoffSeconds(attempts: number): number {
    return Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3_600);
}

export type MailRequest = {
    template: string;
    /** What this mail is for. See the key table in `./templates/index.ts`. */
    dedupeKey: string;
    toEmail: string;
    toName?: string | null;
    locale?: Locale;
    customerId?: string | null;
    eventId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    payload: Record<string, unknown>;
    maxAttempts?: number;
};

/**
 * Queues one mail inside the caller's transaction.
 *
 * Returns the new row's id, or `null` when a mail for that cause was already
 * there. The caller does **not** look first: a lookup is a race, and
 * `email_log (template, to_email, dedupe_key)` is the answer.
 *
 * Takes a transaction handle on purpose — the same reason `emitEvent` does.
 * A mail queued beside the write it announces is a mail that can go out about
 * a fact that rolled back.
 */
export async function queueMail(
    tx: Tx,
    request: MailRequest,
): Promise<string | null> {
    const template = mailTemplate(request.template);

    if (!template) {
        throw new Error(`Unknown mail template: ${request.template}`);
    }

    if (template.delivery !== "outbox") {
        throw new Error(
            `${request.template} is a direct template; use recordMail() after sending it`,
        );
    }

    // zod on the way in: a payload that cannot render is the *emitter's* bug,
    // and catching it here means the sweep never holds a row it can only ever
    // fail on. The parsed value is what is stored, so defaults are applied
    // once rather than on every render.
    const payload = template.payload.parse(request.payload);

    const id = createId("email");

    const written = await tx
        .insert(schema.emailLog)
        .values({
            id,
            template: request.template,
            dedupeKey: request.dedupeKey,
            locale: request.locale ?? "de",
            toEmail: request.toEmail.trim().toLowerCase(),
            toName: request.toName ?? null,
            customerId: request.customerId ?? null,
            eventId: request.eventId ?? null,
            entityType: request.entityType ?? null,
            entityId: request.entityId ?? null,
            payload: payload as Record<string, unknown>,
            maxAttempts: request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        })
        .onConflictDoNothing({
            target: [
                schema.emailLog.template,
                schema.emailLog.toEmail,
                schema.emailLog.dedupeKey,
            ],
        })
        .returning({ id: schema.emailLog.id });

    return written[0]?.id ?? null;
}

/**
 * Records a mail that a synchronous path already sent itself.
 *
 * The `direct` half of the catalogue: a verification link has to be sent
 * inside the request that asked for it, because telling somebody "check your
 * inbox" for a mail that was only *queued* is how an account gets stuck
 * behind a mail that never went. Those send first and record afterwards — so
 * the row is a record and not a request, and the sweep never touches it.
 *
 * It is keyed exactly like a queued one, so a retried request (a
 * double-submitted form, a proxy replaying a POST) records once rather than
 * filling the log with copies of the same send.
 */
export async function recordMail(
    db: Db,
    input: {
        template: string;
        dedupeKey: string;
        toEmail: string;
        toName?: string | null;
        locale?: Locale;
        customerId?: string | null;
        entityType?: string | null;
        entityId?: string | null;
        subject: string;
        bodyText?: string | null;
        /** What actually happened. */
        outcome:
            | { sent: true; messageId: string | null; transport: string }
            | { sent: false; error: string };
        at?: Date;
    },
): Promise<void> {
    const at = input.at ?? new Date();

    await db
        .insert(schema.emailLog)
        .values({
            id: createId("email"),
            template: input.template,
            dedupeKey: input.dedupeKey,
            locale: input.locale ?? "de",
            toEmail: input.toEmail.trim().toLowerCase(),
            toName: input.toName ?? null,
            customerId: input.customerId ?? null,
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            // A recorded mail keeps no payload: it was rendered by the caller
            // and there is nothing for this table to re-render it from. The
            // subject and the text part are the record.
            payload: {},
            subject: input.subject,
            bodyText: input.bodyText ?? null,
            attempts: 1,
            maxAttempts: 1,
            ...(input.outcome.sent
                ? {
                      status: "sent" as const,
                      sentAt: at,
                      messageId: input.outcome.messageId,
                      transport: input.outcome.transport,
                  }
                : {
                      status: "abandoned" as const,
                      lastError: input.outcome.error.slice(0, 1_000),
                  }),
        })
        .onConflictDoNothing({
            target: [
                schema.emailLog.template,
                schema.emailLog.toEmail,
                schema.emailLog.dedupeKey,
            ],
        });
}

/**
 * Takes one row out of the queue, or refuses.
 *
 * The conditional update **is** the claim: two sweeps racing on the same row
 * produce one winner and one empty result, because Postgres serialises the
 * two updates on the row and the loser's `status in ('pending','failed')` is
 * no longer true. A read-then-write would have both of them send.
 *
 * `attempts < max_attempts` is in the condition rather than only in the
 * sweep's select, so a row whose ladder ran out between the two is refused
 * rather than given one more go.
 */
export async function claimMail(
    db: Pick<typeof defaultDb, "update">,
    id: string,
    at: Date = new Date(),
): Promise<boolean> {
    const claimed = await db
        .update(schema.emailLog)
        .set({
            status: "sending",
            attempts: sql`${schema.emailLog.attempts} + 1`,
            claimedAt: at,
            updatedAt: at,
        })
        .where(
            and(
                eq(schema.emailLog.id, id),
                inArray(schema.emailLog.status, ["pending", "failed"]),
                sql`${schema.emailLog.attempts} < ${schema.emailLog.maxAttempts}`,
                or(
                    isNull(schema.emailLog.runAfter),
                    lte(schema.emailLog.runAfter, at),
                ),
            ),
        )
        .returning({ id: schema.emailLog.id });

    return claimed.length > 0;
}

/**
 * Records that the mail went out.
 *
 * The one write that must not be lost. If it throws, the row stays `sending`
 * and becomes `unknown` when the claim goes stale — see the header. It is
 * deliberately a single statement with no transaction around it: there is
 * nothing to write it with if the connection is the thing that failed, and
 * wrapping it would only widen the window.
 */
async function recordSent(
    db: Pick<typeof defaultDb, "update">,
    input: {
        id: string;
        subject: string;
        bodyText: string;
        messageId: string | null;
        transport: string;
        at: Date;
    },
): Promise<void> {
    await db
        .update(schema.emailLog)
        .set({
            status: "sent",
            sentAt: input.at,
            subject: input.subject,
            bodyText: input.bodyText,
            messageId: input.messageId,
            transport: input.transport,
            claimedAt: null,
            lastError: null,
            updatedAt: input.at,
        })
        .where(eq(schema.emailLog.id, input.id));
}

/**
 * Records a failure and sets the next attempt — or gives up.
 *
 * The attempt was already counted at the claim, so this reads the row's own
 * counter rather than adding to it. A failure that was the last one names
 * itself `abandoned`; one with attempts to spare is `failed` **with a
 * backoff**, because `failed` is runnable and a "permanent" failure without
 * one would be retried a minute later (Phase 8 shipped exactly that).
 */
async function recordFailure(
    db: Pick<typeof defaultDb, "update">,
    input: { id: string; attempts: number; maxAttempts: number; error: string },
    at: Date,
): Promise<void> {
    const spent = input.attempts >= input.maxAttempts;

    await db
        .update(schema.emailLog)
        .set({
            status: spent ? "abandoned" : "failed",
            runAfter: spent
                ? null
                : new Date(
                      at.getTime() + mailBackoffSeconds(input.attempts) * 1_000,
                  ),
            claimedAt: null,
            lastError: input.error.slice(0, 1_000),
            updatedAt: at,
        })
        .where(eq(schema.emailLog.id, input.id));
}

/**
 * Turns claims that went stale into `unknown`.
 *
 * **Never back to `pending`.** A row that is still `sending` a quarter of an
 * hour after it was claimed is one of two things: a process that died before
 * it could send, or a process that sent and died before it could say so.
 * Nothing in the database can tell those apart, and only one of them is safe
 * to repeat — so neither is repeated. The operator sees „Zustellung
 * ungeklärt" and decides.
 */
export async function expireStaleClaims(
    db: Pick<typeof defaultDb, "update">,
    at: Date = new Date(),
): Promise<number> {
    const expired = await db
        .update(schema.emailLog)
        .set({
            status: "unknown",
            lastError:
                "Der Versandvorgang wurde nicht abgeschlossen; ob die Nachricht zugestellt wurde, ist nicht feststellbar.",
            updatedAt: at,
        })
        .where(
            and(
                eq(schema.emailLog.status, "sending"),
                lt(
                    schema.emailLog.claimedAt,
                    new Date(at.getTime() - CLAIM_TIMEOUT_MS),
                ),
            ),
        )
        .returning({ id: schema.emailLog.id });

    return expired.length;
}

export type RenderedMessage = {
    subject: string;
    text: string;
    html: string;
};

/**
 * Turns a row into a message. Pure apart from the settings it is handed:
 * given the same row, the same settings and the same catalogue it produces
 * the same bytes, which is what makes the admin preview honest.
 */
export function renderMailRow(
    row: {
        template: string;
        locale: string;
        payload: unknown;
    },
    settings: Settings,
): RenderedMessage {
    const template = mailTemplate(row.template);

    if (!template) {
        throw new Error(`Unknown mail template: ${row.template}`);
    }

    const locale = toLocale(row.locale);
    const payload = template.payload.parse(row.payload);

    const rendered: RenderedMail = template.render(payload, {
        locale,
        settings,
        t: translator(locale, "mail") as unknown as MailText,
        labels: translator(locale, "labels") as unknown as MailText,
        common: translator(locale, "common") as unknown as MailText,
    });

    const text = [
        ...rendered.intro,
        ...(rendered.action
            ? ["", `${rendered.action.label}: ${rendered.action.url}`]
            : []),
        ...(rendered.rows.length > 0
            ? ["", ...rendered.rows.map((row) => `${row.label}: ${row.value}`)]
            : []),
        ...(rendered.outro.length > 0 ? ["", ...rendered.outro] : []),
    ].join("\n");

    return {
        subject: rendered.subject,
        text,
        html: renderEmailWith(settings, {
            preheader:
                rendered.intro[rendered.intro.length - 1] ?? rendered.subject,
            heading: rendered.heading,
            intro: rendered.intro,
            ...(rendered.action ? { action: rendered.action } : {}),
            rowsTitle: rendered.rowsTitle,
            rows: rendered.rows,
            outro: rendered.outro,
            locale,
        }),
    };
}

/**
 * Thrown when a mail cannot be sent *yet* — the document it attaches has not
 * been written to storage. Distinct from a send failure so the reason in the
 * log says which it was; it still costs an attempt, because a document that
 * is permanently missing must eventually stop being asked for.
 */
class DocumentNotReadyError extends Error {}

async function resolveAttachments(row: {
    template: string;
    payload: unknown;
}): Promise<
    { filename: string; content: Buffer; contentType: string }[] | null
> {
    const template = mailTemplate(row.template);

    if (!template?.attachments) {
        return [];
    }

    const refs = template.attachments(template.payload.parse(row.payload));

    if (refs.length === 0) {
        return [];
    }

    const storage = documentStorage();
    const out: { filename: string; content: Buffer; contentType: string }[] =
        [];

    for (const ref of refs) {
        const bytes = await storage.get(ref.key);

        if (!bytes) {
            /**
             * The document is not there. The mail is **not** sent without it:
             * an invoice notice whose invoice is missing is worse than a late
             * one, and the usual cause is a sweep that overtook the renderer
             * by a few seconds.
             */
            throw new DocumentNotReadyError(
                `Das Dokument ${ref.key} liegt noch nicht im Speicher.`,
            );
        }

        out.push({
            filename: ref.filename,
            content: bytes,
            contentType: ref.contentType,
        });
    }

    return out;
}

export type OutboxReport = {
    sent: number;
    failed: number;
    skipped: number;
    expired: number;
};

/**
 * One pass of the outbox.
 *
 * Sequential rather than parallel, for the reason the provisioning sweep is:
 * these go to one relay or one Graph tenant, and twenty at once is a
 * throttled tenant and twenty rows that all report 429.
 */
/**
 * **One clock per pass.** The selection asks `run_after <= now`, the claim
 * stamps `claimed_at = now`, the backoff is `now + …` and the send is recorded
 * at `now` — all from the same instant. Mixing an injected `now` into the
 * selection and the real clock into the backoff is how a row gets a
 * `run_after` the sweep's own query can never reach; in production the two are
 * seconds apart and in a test they are years.
 */
export async function runMailOutbox(
    db: typeof defaultDb,
    options: {
        now?: Date;
        limit?: number;
        /** Injected by the tests; resolved per pass otherwise. */
        transport?: MailTransport | null;
        settings?: Settings;
    } = {},
): Promise<OutboxReport> {
    const now = options.now ?? new Date();
    const report: OutboxReport = { sent: 0, failed: 0, skipped: 0, expired: 0 };

    report.expired = await expireStaleClaims(db, now);

    const due = await db
        .select()
        .from(schema.emailLog)
        .where(
            and(
                inArray(schema.emailLog.status, ["pending", "failed"]),
                sql`${schema.emailLog.attempts} < ${schema.emailLog.maxAttempts}`,
                or(
                    isNull(schema.emailLog.runAfter),
                    lte(schema.emailLog.runAfter, now),
                ),
            ),
        )
        .orderBy(asc(schema.emailLog.id))
        .limit(options.limit ?? 25);

    if (due.length === 0) {
        return report;
    }

    const settings = options.settings ?? (await loadSettings());
    const transport =
        options.transport !== undefined
            ? options.transport
            : await mailTransport();

    if (!transport) {
        /**
         * No way out of the building. The rows are left exactly as they are —
         * **no attempt is counted** — because "there is no relay configured"
         * is not a property of the message and must not burn its ladder. This
         * installation has no SMTP relay and no Microsoft 365 tenant, so this
         * is the ordinary case here rather than an exception.
         */
        console.error(
            `[mail] ${due.length} message(s) waiting and no transport configured`,
        );
        report.skipped = due.length;

        return report;
    }

    for (const row of due) {
        if (!(await claimMail(db, row.id, now))) {
            // Somebody else got it, or its ladder ran out between the select
            // and here.
            report.skipped += 1;
            continue;
        }

        // The row's own counter, as it now stands after the claim.
        const attempts = row.attempts + 1;
        let message: RenderedMessage | null = null;

        try {
            message = renderMailRow(row, settings);
            const attachments = await resolveAttachments(row);

            const sent = await transport.sendMail({
                from: settings.operator.email,
                to: row.toName ? `${row.toName} <${row.toEmail}>` : row.toEmail,
                subject: message.subject,
                text: message.text,
                html: message.html,
                ...(attachments && attachments.length > 0
                    ? { attachments }
                    : {}),
            });

            /**
             * From here on the customer has the mail. Everything below is
             * bookkeeping, and if it fails the row is deliberately left
             * `sending` — see the header.
             */
            try {
                await recordSent(db, {
                    id: row.id,
                    subject: message.subject,
                    bodyText: message.text,
                    messageId: sent.messageId,
                    transport: transport.id,
                    at: now,
                });
            } catch (error) {
                console.error(
                    `[mail] ${row.id} was sent and could not be recorded; it stays 'sending' and will become 'unknown':`,
                    error,
                );
                throw new RecordingFailed();
            }

            report.sent += 1;
        } catch (error) {
            if (error instanceof RecordingFailed) {
                // Already logged, already in the one state that must not be
                // retried. Not counted as sent and not counted as failed: the
                // report would be claiming to know which it was.
                continue;
            }

            logMailError(`${row.template} → ${row.toEmail}`, error);

            await recordFailure(
                db,
                {
                    id: row.id,
                    attempts,
                    maxAttempts: row.maxAttempts,
                    error:
                        error instanceof DocumentNotReadyError
                            ? error.message
                            : error instanceof Error
                              ? error.message
                              : String(error),
                },
                now,
            );

            report.failed += 1;
        }
    }

    return report;
}

/** Signals "sent, not recorded" out of the inner try without a flag. */
class RecordingFailed extends Error {}

/**
 * Whether „erneut senden" may be offered for this row.
 *
 * A `direct` mail is not resendable through the outbox and there is nothing
 * dishonest about saying so: `recordMail` stores no payload, because the
 * caller rendered the message and this table has nothing to re-render it
 * from. For a document mail the right repeat is the admin action that renders
 * the document again — one document-sending path, not two.
 */
export function isResendable(template: string): boolean {
    const known = mailTemplate(template);

    return known !== null && known.delivery === "outbox" && known.resendable;
}

/**
 * Claims the next resend of a row, and queues it as a new one.
 *
 * **A resend is a new row**, because a row with `sent_at` is the record of a
 * mail that left the building and rewriting it loses that.
 *
 * The number is claimed with a conditional update against the counter the
 * form was rendered with, which is what makes a double-clicked button send
 * once: the second request carries the same expected value, finds the counter
 * already moved and gets nothing. It is the same shape as
 * `auto_reply_budget`'s conditional increment and it is there for the same
 * reason — a count somebody read a moment ago is not a claim.
 *
 * Returns the new row's id, or `null` when the claim was lost.
 */
export async function resendMail(
    db: typeof defaultDb,
    input: { id: string; expectedResendCount: number },
): Promise<string | null> {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .select({
                template: schema.emailLog.template,
                resendCount: schema.emailLog.resendCount,
            })
            .from(schema.emailLog)
            .where(eq(schema.emailLog.id, input.id))
            .limit(1);

        if (!row) {
            return null;
        }

        /**
         * Refused **before** the counter is claimed, so a refusal does not
         * burn a resend number. The reasons it can be refused are properties
         * of the template, not of the row, so this needs no lock to decide.
         */
        if (!isResendable(row.template)) {
            throw new Error(
                `${row.template} kann nicht erneut versendet werden.`,
            );
        }

        const claimed = await tx
            .update(schema.emailLog)
            .set({
                resendCount: input.expectedResendCount + 1,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.emailLog.id, input.id),
                    eq(schema.emailLog.resendCount, input.expectedResendCount),
                ),
            )
            .returning();

        const original = claimed[0];

        if (!original) {
            return null;
        }

        const id = createId("email");

        await tx.insert(schema.emailLog).values({
            id,
            template: original.template,
            // The resend's own cause: this row, this many resends in.
            dedupeKey: `resend:${original.id}:${input.expectedResendCount + 1}`,
            locale: original.locale,
            toEmail: original.toEmail,
            toName: original.toName,
            customerId: original.customerId,
            eventId: original.eventId,
            entityType: original.entityType,
            entityId: original.entityId,
            payload: original.payload,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
            resendOfId: original.id,
        });

        return id;
    });
}
